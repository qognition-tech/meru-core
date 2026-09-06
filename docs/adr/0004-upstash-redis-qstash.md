# 0004 — Upstash Redis (REST) for rate limiting, revocation and idempotency; QStash as the minute scheduler

**Status:** Proposed — 2026-09-05. Not merged. Requires `quality` (Owen) review before
implementation, and `secops` (Anton) review specifically for revocation and idempotency, per
`definition-of-done.md`'s "auth, tenancy" gate.

**Scope:** introduces `@upstash/redis` for three purposes the current in-memory mechanisms
cannot actually provide on Vercel's serverless model, and Upstash QStash as the external
scheduler `/jobs/tick?scope=fast` has needed since workspace `CLAUDE.md` §10 was written.

---

## 1. Context

### 1.1 What is broken today, not hypothetically — verified in the code's own comments

**Rate limiting is not deployed at all in production.** `src/main.ts:80-106` configures
`express-rate-limit` with the default **in-memory `MemoryStore`**, vertical-aware
(`immigrationMax`/`bankingMax`), keyed on `${ip}::${tenantId header}`. But
`api/index.js:114-116` — **the file that actually runs on Vercel** (workspace `CLAUDE.md` §10:
`main.ts` is mirrored there "by hand") — contains this comment instead of the rate limiter:

> *"Rate limiting is deliberately omitted: express-rate-limit's in-memory store is per-lambda,
> so it provides no real limit across instances. Use the platform WAF or a shared store
> (Upstash/Vercel KV) instead."*

So today, **`/auth/login`, `/auth/refresh` and every AI route are unthrottled in production.**
`main.ts`'s rate limiter only ever runs for `npm run start` (local/non-serverless), which is not
how this API is deployed. This is the single most consequential finding in this ADR — it is
not "the rate limiter is weak", it is "there is no rate limiter."

**Session revocation is a bounded-staleness cache, and that bound holds even per-instance —
this one is not broken, just worth stating precisely.** `JwtStrategy.assertSessionLive`
(`src/iam/strategies/jwt.strategy.ts:70-101`) caches a live/revoked verdict in `CACHE_MANAGER`
for 60s. `CacheModule.register()` (`src/core/core.module.ts:7`) with no store argument is the
default **in-memory** Keyv store — also per-lambda. Unlike rate limiting, this does not silently
become "no limit": each instance's cache entry independently expires within 60 seconds of being
set, so the worst-case revocation lag (~60s) is the same whether the cache is shared or not.
**This ADR moves it to Redis anyway** — not to fix a bug, but because D2 makes revocation
**fail closed** on a cache-read error, and a shared store is what makes "fail closed" mean
something better than "every cold instance re-checks the database," which is the current
fail-closed behaviour already (`:93-95`, the `catch { return; }` — worth flagging: **this
currently fails OPEN**, not closed, on a cache error; see D2).

**Idempotency does not exist.** `grep -rn "Idempotency\|idempotencyKey"` across `src/` returns
one match, `src/webhooks/inbound-webhook.service.ts`, which is Stripe's own signature-based
dedup, not a general mechanism. `POST /payments`, `POST /iam/users/invite` and every other
mutating POST has no double-submit protection. A retried request (a flaky mobile connection
resubmitting a payment-recording form) creates a duplicate row today.

**`CRON_SECRET` is set on Vercel Production** (workspace `CLAUDE.md` §10, verified 2026-08-22),
so the two Vercel crons (`scope=daily` at `0 2 * * *`, `scope=fast` at `0 3 * * *` — both
**daily**, not minute-level) are authorised. But nothing pings `/api/v1/jobs/tick?scope=fast`
at the minute cadence `JOB_CADENCE_MINUTES` expects (`src/jobs/jobs.controller.ts:63-97`) —
queue drain, notification dispatch, the SLA watchdog and alert rules all run **at most once a
day** in practice. `CronSecretGuard` (`src/jobs/cron-secret.guard.ts:21-47`) already fails
closed with no code change needed; it only needs a caller.

### 1.2 The serverless constraint, restated for this ADR specifically

Workspace `CLAUDE.md` §10: 1024 MB / 60s / `sin1`, DB pool `max: 1`, no held-open connections.
**Any Redis client using a raw TCP connection (`ioredis`) is the wrong shape here** — it was
already tried once for BullMQ and explicitly ripped out: `src/queue/queue.module.ts:28-34`'s
comment records that a bare `ioredis` connection attempt with no Redis reachable **blocked
`app.listen()` forever** during a retry loop, with no output, because `ioredis` retries
indefinitely by default. `@upstash/redis` is REST-based (HTTP, not a persistent socket) —
exactly the shape a per-invocation serverless function needs, and exactly why the operator's
standing choice is Upstash rather than a self-hosted Redis.

---

## 2. Decisions

### D1 — rate limiting moves to `@upstash/redis`, fixed-window, applied at the same two middleware layers, deployed to `api/index.js` this time

**Decision.** Replace `express-rate-limit`'s `MemoryStore` with a small custom counter using
`@upstash/redis`'s atomic `INCR` + `EXPIRE`, applied as Express middleware in **both**
`src/main.ts` and `api/index.js` — the omission in `api/index.js` was deliberate-and-documented
for the old in-memory approach; it is not deliberate for a shared store, and leaving it out a
second time reproduces exactly the gap this ADR exists to close.

```ts
// src/core/rate-limit/upstash-rate-limiter.ts (new)
async function checkLimit(redis: Redis, key: string, max: number, windowSec: number) {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSec);
  return count <= max;
}
```

**Scope, per route class, matching the operator's brief:**

| Route class | Key | Window | Limit (default) |
|---|---|---|---|
| `/auth/login`, `/auth/refresh`, `/auth/forgot-password`, `/auth/federated/*` (ADR 0002) | `rl:auth:{ip}` — **not** tenant-keyed, because pre-auth there is no trustworthy tenant | 60s | 10 |
| `/ai/execute`, `/engines/ai/*` (ADR 0003) | `rl:ai:{tenantId}` | 60s | existing `immigrationMax`/`bankingMax` values, unchanged |
| Everything else | `rl:global:{ip}::{tenantId}` | existing `ttlMs` | existing `globalMax` | 

**Why fixed-window `INCR`/`EXPIRE` and not a token bucket or Upstash's `@upstash/ratelimit`
package.** The operator's brief says `@upstash/redis`, not the higher-level ratelimit SDK —
kept deliberately minimal: two Redis commands, both atomic on Upstash's server, no client-side
race. A token bucket is more accurate under bursty traffic but is not needed to close the gap
that exists today (no limit at all); it is a tuning improvement for later, not a blocker (see
§6).

**Fail-open, deliberately, and this is the one place in this ADR that fails open.** If Upstash
is unreachable (timeout, outage), the limiter logs and **allows the request** rather than
blocking all traffic. Rationale: an availability outage on the rate limiter must not become an
availability outage on the whole API — the WAF/CDN in front of Vercel is the backstop for a
volumetric attack, and this limiter's job is application-aware throttling (per-tenant fairness,
brute-force slowdown), not the last line of defense. **Contrast with D2's revocation check,
which fails closed** — the two failure directions are not the same decision, and conflating
them would be wrong in both directions: failing closed on rate limiting turns an Upstash blip
into a full outage; failing open on revocation turns an Upstash blip into a security hole.

### D2 — refresh-token / session revocation cache moves to Redis and fails closed on a cache error, correcting a real gap

**Decision.** `JwtStrategy.assertSessionLive` replaces `CACHE_MANAGER` with `@upstash/redis`,
same 60s TTL, same key shape (`session-live:{sessionId}`). The **behavioural change**, not just
a store swap: today, a cache-read error is caught and swallowed (`:93-95`, `catch { return; }`
— `live` stays `true`, its initialized default), so **a Redis outage during the revocation
check currently fails OPEN** — a revoked session behind a failed cache read is treated as live.
After this change, a cache-read error triggers the fallback **database** check
(`TenantContext.runAsSystem(... sessionRepo.findOne ...)`, the same query already in the
`try` block) rather than assuming `live`. Only if **both** the cache and the database are
unreachable does the request fail — and at that point the database is down, which already fails
every other request in the API, so this adds no new failure mode.

**Why this is "fails closed" and not merely "queries the DB every time".** The point of the
cache was to avoid a DB read on every request. Falling through to the DB on a cache miss is
already what the code does (`:80-92`); the fix is narrowly that a cache-read *error* must be
treated as a cache *miss*, not as a cached `true`. This is a two-line change with a large
consequence, and it belongs in this ADR because moving the store is the natural moment to fix
it — shipping the Redis migration without the fix would carry the same latent bug into the new
store.

### D3 — idempotency keys on payment and invite POSTs, Upstash-backed, `SETNX`-based

**Decision.** `POST /payments`, `POST /payments/schedule`, `POST /iam/users/invite` and
`POST /tenants/signup` accept an optional `Idempotency-Key` header (a client-generated UUID).
On receipt:

```ts
const key = `idem:${tenantId}:${route}:${idempotencyKey}`;
const reserved = await redis.set(key, 'in-flight', { nx: true, ex: 86400 }); // 24h
if (!reserved) {
  const cached = await redis.get(`${key}:result`);
  if (cached) return JSON.parse(cached);           // replay the original response
  throw new ConflictException('Request already in flight');   // 409, concurrent duplicate
}
// ... handler runs ...
await redis.set(`${key}:result`, JSON.stringify(responseBody), { ex: 86400 });
```

**Error code:** a duplicate submission that is still processing returns `409
MER-VAL-0013 "A request with this Idempotency-Key is already being processed"`. A duplicate
submission of an already-completed request returns the **original response, replayed**, at
whatever status code it originally returned — not a fresh 200, so a client cannot be fooled
into thinking a second charge occurred when the first is what actually happened.

**Why 24-hour TTL and not indefinite.** Matches the existing `INVITE_TTL_DAYS` order of
magnitude (`iam.service.ts:59`) and bounds Redis storage growth; a client retrying a payment
POST more than a day after the original attempt is not the double-submit case this exists to
catch — it is a new attempt, and should be treated as one.

**Why the header is optional, not mandatory.** Making it mandatory on `POST /payments` today
would break every existing frontend caller with no transition period, three separate `lib/api/`
clients each needing a change (workspace `CLAUDE.md` §7, `meru-core-fe/CLAUDE.md` §2). Optional
now, with the frontends adding it as a follow-up per-app change; mandatory is a **future**
decision, tracked in §6.

### D4 — Upstash QStash becomes the external scheduler for `scope=fast`, closing the gap workspace `CLAUDE.md` §10 has named since inception

**Decision.** A QStash schedule calls `POST https://meru-core.vercel.app/api/v1/jobs/tick?scope=fast`
every minute, `Authorization: Bearer ${CRON_SECRET}` — the exact contract `CronSecretGuard`
already enforces (`cron-secret.guard.ts:32-44`), **zero code change** to the jobs surface. This
is purely operational configuration (a QStash schedule + the existing secret), not a code
change, which is why it belongs in this ADR rather than a separate one: it shares Upstash as
infrastructure but touches no shared code path with D1–D3.

**Why QStash over `cron-job.org`** (the free alternative workspace `CLAUDE.md` §10 already
names). Same operator (Upstash), one fewer third party with access to `CRON_SECRET`, and
QStash's delivery retries with backoff are a genuine improvement over a bare external pinger —
if `/jobs/tick` 5xxs, QStash retries; `cron-job.org`'s free tier does not guarantee that.

**Why this does not replace the two Vercel crons.** `scope=daily` stays on Vercel Cron — it
needs no minute-level cadence, and reducing the number of things that must be independently
configured for the platform to function at all is worth more than consolidating onto one
scheduler for its own sake.

---

## 3. Options rejected

| Option | Why rejected |
|---|---|
| `ioredis` (raw TCP client) for any of D1–D3 | Already tried for BullMQ and explicitly reverted — blocks `app.listen()` indefinitely with no Redis reachable (`queue.module.ts:28-34`). Wrong shape for a per-invocation serverless function regardless of which capability it backs |
| `@upstash/ratelimit` (the higher-level SDK) instead of raw `INCR`/`EXPIRE` | Not what the operator specified; adds a dependency and an abstraction layer for a fixed-window limiter that two Redis commands already implement correctly |
| Fail closed on the rate limiter (block on Upstash outage) | Turns an infrastructure blip into a full API outage; the WAF/CDN layer is the intended backstop for volumetric abuse, not this limiter (D1) |
| Fail open on revocation (keep today's behaviour) | This is the actual, if narrow, security gap in the current code (D2) — a Redis/cache outage currently treats a revoked session as live |
| Mandatory `Idempotency-Key` on the first release | Breaks three untouched frontend clients with no transition; optional-first is additive (D3) |
| Vercel KV instead of Upstash | Contradicts the operator's stated stack decision (Upstash for Redis) with no material advantage argued for switching |

---

## 4. Consequences

1. **A new external dependency sits on the hot path of every request** (rate limiting) and on
   login specifically (revocation check). Upstash's own availability becomes part of Meru's.
   D1's fail-open design bounds this for rate limiting; D2's fallback-to-DB bounds it for
   revocation.
2. **`api/index.js` gains a rate limiter it has never had in production.** The first deploy
   after this ships is the first time real traffic is throttled at all — expect some legitimate
   bursty traffic (a firm's staff all refreshing a dashboard at 9am) to be newly rate-limited if
   `globalMax`/`immigrationMax`/`bankingMax` are not re-tuned against real usage first.
3. **Idempotency keys add a Redis round-trip to every payment/invite POST that supplies one**,
   and a small amount of Redis storage (24h TTL, bounded).
4. **QStash becomes a fourth thing that must be correctly configured for the platform's
   scheduled work to run** — alongside `CRON_SECRET`, the two Vercel crons, and the jobs
   controller itself. `GET /jobs/status` (workspace `CLAUDE.md` §12) remains the way to verify
   any of this is actually happening; this ADR does not change that verification story.
5. **The rate-limit keying by raw client IP is imperfect behind Vercel's edge** — `req.ip` may
   be a proxy hop rather than the true client IP depending on `trust proxy` configuration
   `[UNVERIFIED: whether Express `trust proxy` is set correctly for Vercel's `sin1` region —
   check before relying on IP-based keys for anything security-critical, e.g. `/auth/login`]`.

---

## 5. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| D1 rate limiter | Revert the commit; `api/index.js` returns to no rate limiting (today's actual production state) — this is a true rollback to the status quo, not an improvement over it | Redis counter keys expire on their own TTL; nothing to clean up |
| D2 revocation fail-closed fix + Redis store | Revert the store swap independently of the fail-closed fix if needed — the fix is two lines and can ship alone even if the Redis migration is rolled back, since it applies equally to the in-memory `CACHE_MANAGER` | None |
| D3 idempotency keys | Remove the header handling; existing callers who never sent the header are unaffected either way | In-flight/result keys expire within 24h; no manual cleanup required |
| D4 QStash schedule | Delete the QStash schedule. The daily Vercel crons are unaffected; `scope=fast` work reverts to running at most once daily, as it does today | None — this was infrastructure configuration, no code shipped |

**Rollback verification:** re-run `BASE_URL=https://meru-core.vercel.app npm run smoke:sweep`
(workspace `CLAUDE.md` §9) and confirm no route newly 429s under the sweep's normal call volume
— the sweep is not designed to trip a rate limiter and a false positive there means the limits
are mistuned, not that the sweep is wrong.

---

## 6. What would make these decisions wrong later

| Trigger | Which decision it invalidates | What to do |
|---|---|---|
| Real abuse traffic shows fixed-window `INCR`/`EXPIRE` allows bursts at the window boundary (the classic fixed-window edge case — 2× the limit across a boundary) | D1's algorithm choice | Move to `@upstash/ratelimit`'s sliding-window implementation; the key scheme and route classes carry over unchanged |
| A frontend team is ready to send `Idempotency-Key` on every mutating POST | D3's "optional" stance | Make it mandatory on `/payments`, `/payments/schedule`, `/iam/users/invite` specifically, one route at a time, verified against all three frontends per `meru-core-fe/CLAUDE.md` §2 |
| Upstash's free/low tier request quota is exceeded by the rate-limiter's own traffic (every request now makes a Redis call) | D1's blanket application to "everything else" | Narrow the global rate limiter to authenticated + AI + auth routes only, dropping the catch-all tier, before paying for a higher Upstash plan |
| QStash's delivery guarantee is found insufficient (missed ticks under sustained Upstash outage) | D4 | Re-add `cron-job.org` as a redundant second pinger — cheap, and workspace `CLAUDE.md` §10 already names it as the fallback option |
| `/auth/login` rate limiting by IP alone proves gameable (distributed credential stuffing from many IPs) | D1's per-route keying | Add a second, account-keyed limiter (`rl:auth:{email}`) alongside the IP-keyed one — different key, same mechanism |

---

## 7. Open items for the implementers

| # | Item | Owner |
|---|---|---|
| 1 | `[UNVERIFIED]` Confirm Express `trust proxy` setting is correct for Vercel `sin1` before relying on `req.ip` for the auth rate limiter | Luke, with Jonas |
| 2 | Re-tune `globalMax`/`immigrationMax`/`bankingMax` against real traffic before this ships, not after — the first deploy is the first time these numbers mean anything | Jonas |
| 3 | Provision the Upstash Redis database and QStash schedule; confirm `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` on Vercel via `vercel env ls` (not `env pull`, workspace §12) before merging | Jonas |
| 4 | Decide per-app rollout order for `Idempotency-Key` in the three frontend clients | Mira |
| 5 | Security review of D2's revocation fail-closed change and D1's fail-open rate-limit change — confirm the asymmetry is correct, not just convenient | Anton |
