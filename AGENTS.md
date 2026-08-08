# AGENTS.md — session state, read this first

Working notes for whoever picks this up (human or agent). `CLAUDE.md` holds the
architecture; this holds *what is happening right now*.

---

## 0. Where the code lives

`~/Documents/GitHub/meru-core` and `~/Documents/GitHub/meru-core-fe` are
readable again and in sync with `~/dev` and with `origin/main` (verified
2026-08-08: identical HEADs, `.git` intact, 188 source files readable).
The evicted copies were moved aside as `*.BROKEN` — delete those once the
iCloud quota is freed. Either clone is safe to work in; do not edit both.

---

## 1. Production is UP (restored 2026-08-08)

`https://meru-core.vercel.app` serves `/health` 200 with `database: "up"`,
Swagger UI at `/api`, and 216 paths / 261 operations at `/api-json`. The
runtime connects as `meru_app` with `bypassrls: false`, so RLS is enforced.

### What it actually was — `615a8db`

`WatchlistEntry.country` was declared `string | null` with **no explicit
`type`** on its `@Column`. TypeORM infers column types from
`emitDecoratorMetadata`, and a nullable union emits `design:type = Object`,
which Postgres has no mapping for. Metadata build threw
`DataTypeNotSupportedError`.

**Why it cost hours:** TypeORM raises that through its connection-retry loop,
logging it as `Unable to connect to the database. Retrying (1)...`. The error
message named the one subsystem that was never broken, which is why four
consecutive fixes went after Joi validation, `sslmode`, esbuild bundling and
the Elasticsearch ping. `__diag?db=1` proved both roles connect in 31–48ms.

In production the loop ran 10 attempts at 3s, so the process spent 30s+ before
it could throw and Vercel killed it first — no stack, no log, and
`__diag?boot=1` dying too *despite being wrapped in try/catch*. **A boot probe
that is itself killed means a hang or a timeout, never an exception.** That
single observation is what localised it.

`retryAttempts` is now 1 on serverless: retrying a non-retryable metadata error
ten times only guarantees the cause is never reported before teardown.

### Lesson worth keeping

Never let TypeORM infer a nullable column's type. `scripts/` has no linter for
this yet — a scan for `@Column` without `type:` on a `| null` property found
exactly one occurrence, and it was this one.

### Build/deploy shape — `8a53466`, `8a70e22`

pnpm is the only package manager (`packageManager: pnpm@10.26.2`,
`pnpm install --frozen-lockfile`). `package-lock.json` is deleted and
gitignored. Two traps already hit:
- `.vercelignore` used to exclude `pnpm-lock.yaml`; with `--frozen-lockfile`
  that fails as `ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE`, which reads
  like a stale lockfile rather than a missing one.
- pnpm 10 skips postinstall scripts unless named. `bcrypt` is native — see
  `pnpm.onlyBuiltDependencies` in package.json. Dropping it breaks every login.

### Rollback note

Older deployment URLs return **200 because of Vercel's protection page**, not
because they are healthy. Do not treat that as a signal — check the body.
`vercel promote` failed with "belongs to a different team" / "not ready"; a
rollback likely needs the Vercel dashboard.

---

## 2. Blocked on the account owner

1. **iCloud quota** — 2,392 bytes free. Empty Trash; delete the Next.js build
   output dumped at the CloudDocs root and `.Trash/qognition-labs/node_modules`.
2. **`STRIPE_SECRET_KEY`** + `STRIPE_PRICE_STARTER` / `_PROFESSIONAL` /
   `_ENTERPRISE`. Code is done; `/billing/checkout` returns a clean 503 until set.
3. **`RESEND_API_KEY` + `MAIL_FROM`** — tenant invites currently log the link
   instead of emailing it (`inviteSent: false`).
4. **External scheduler** → `POST /api/v1/jobs/tick?scope=fast` with
   `Authorization: Bearer $CRON_SECRET`. GitHub Actions is disabled, and
   `vercel.json` crons only fire daily, so queue drain, notification dispatch
   and watchlist ingest currently run once a day.

---

## 3. Open bugs, highest severity first

**Cross-client data exposure inside a tenant.** *(Fixed — `32147ed`.)*
`GET /crm/entities` had no server-side owner filter, so a `client`-role token
received every case in the firm; ImmiStack's `fetchMyCase` filtered in the
browser, which is presentation, not authorisation. Worth remembering as a
category: **RLS isolates tenants from each other, not users within a tenant.**
Any new list endpoint needs its own intra-tenant scoping.

**Onboarding created unusable accounts.** (Fixed in FE.) `POST /tenants/signup`
requires a password; the wizard generated random bytes and discarded them, and
that route sends no invite — so the admin was locked out with no reset prompt.

**`/admin/home` fabricated operational data.** (Fixed in FE.) It keyword-matched
canned strings and typed them out to fake streaming — "47 active cases",
"3 payments overdue" — to every user of every tenant, unlabelled.

---

## 4. Backend gaps the frontends are blocked on

Each is behind a `notImplemented()` seam in the relevant app, so the UI states
the missing route rather than faking data.

**Shipped 2026-08-08** — `1f68a85`, `6b28410`. Live and verified in production:
`GET /tenants/:id/{entitlements,branding,connectors}`,
`POST /tenants/:id/impersonate`, `PUT /tenants/me/entitlements`.
The operator trio follows the `/tenants/:id/stats` rule (own tenant ordinary,
another tenant → platform_admin + `runAsGod` + CRITICAL audit). The PUT is
bounded by the plan allowance — an unguarded write there is a free
self-service upgrade. Frontend contracts are in `meru-core-fe/BACKEND-HANDOFF.md`.

**Also shipped 2026-08-08** — `dd6ea14`, `6cd1bfe`, `06d170b`, `3199dd3`,
`3cdc939`. Live at 226 paths / 273 operations:

- **`/payments`** — the firm's receivables, a resource distinct from BILL.
  Explicitly *not* Stripe: Stripe is Meru billing the tenant; a firm settles
  its client fees out of band and records them. Client-role callers are forced
  to their own rows (404, not 403, on someone else's).
- **`GET /documents/checklist`** — driven by the pack's `schema.documentTypes`.
- **`GET /jobs/status`** — now honest, because `job_runs` persists last-run
  state. This also fixed a live bug: the old in-memory `Map` meant every cold
  start believed nothing had run, so daily jobs could re-run on each cold boot.
- **Audit WORM** — `audit_logs` is append-only via triggers (not RLS, which a
  BYPASSRLS owner would evade). Only `archived` may change; DELETE and TRUNCATE
  are refused. Not full WORM: a superuser can drop the trigger. Real
  immutability needs S3 Object Lock export, still outstanding.
- **Scheduled rescreening** — `screening_results` persists every screening, and
  a daily sweep re-checks anything older than the newest list ingest, flagging
  `clear → hit`. It refuses to run on an empty watchlist rather than clearing
  real hits against nothing.

Still missing:

| Missing | Needed by |
|---|---|
| `GET /marketing/campaigns` | No MARKETING module exists. Arguably a category error: campaigns are vertical-specific, so per §3's 80/20 rule this belongs in a config pack or a vertical app, not the horizontal core. Decide before building |
| `GET /communications/threads` | COM is a one-way delivery log; `notifications` has no thread key to group on |

### Databases and watchlists — done, no action needed

All three Neon databases are migrated and identical (27 migrations each,
`payments` / `job_runs` / `screening_results`, no tenant table missing RLS,
WORM triggers present). They turned out to sit on the **same Neon endpoint** —
`govx` and `immistack` are database names on `ep-restless-thunder-azgspl7m`,
not separate projects — so the owner URL reaches all three and no
`/jobs/migrate` call was needed. Worth remembering: the vertical DB URLs are
Vercel-sensitive and `vercel env pull` returns them empty, so that endpoint is
the *only* route if the endpoint ever differs.

Sanctions lists are ingested: **20,210 entries per database** (19,199 OFAC SDN
+ 1,011 UN Consolidated). Screening matches real designations again.

### The defect loading real data exposed — `60a8326`

With `watchlist_entries` empty, screening had never been exercised against
anything. Once 20k rows landed, **every invented name screened as
`escalated`**: a Double Metaphone match awarded a flat 0.85, exactly the
default threshold, so any phonetic collision became a hit.

Phonetic agreement is now corroboration, gated behind a Levenshtein floor —
not Jaro-Winkler, whose prefix bonus rewards a shared forename and cannot
separate "Margarethe Vandersloot"/"MARGARITA 1" (lev 0.36) from
"mohammed ali"/"muhammad ali" (lev 0.83). 0/12 invented names flagged, 40/40
real designations still hit, p95 104ms. `screening.engine.spec.ts` pins both
directions.

**The lesson generalises:** a feature whose data source is empty has not been
tested, only executed. Everything downstream of `watchlist_entries` looked
fine for as long as there was nothing in it.

## 5. Phase status

Done: **P0–P3, P6.** Detail in `docs/MASTER_GAP_ANALYSIS_AND_PLAN.md` §4.

**P4 GovX — essentially complete.** All nine pack-driven module pages built and
pushed (vendor-dd, control-testing, risk-workshop, roadmap, knowledge-base,
training, turnover, rfi, match-review). Verified pack-driven, no mock imports,
no `dangerouslySetInnerHTML`. Unverified: sidebar nav and i18n strings, and
whether the `watchlist-status` guard is wired.

**P5 ImmiStack — largely complete** (`b907d18`). Client portal, settings,
onboarding persistence, detail pages, applicant KYC screening via
`POST /engines/screening`. The duplicate `/platform` console was deleted. Not
done: `POST /engines/doc-intel` (needs a document-picker flow).

**P7–P9 — not started**, and three items in it are not purely engineering:

- **Collaboration/WebSocket cannot run on this deployment at all.** Vercel
  functions terminate per invocation; there is no process to hold a socket
  open. Needs a separate always-on service or a hosted realtime provider —
  decide the host before anyone writes a client.
- **WorldCheck / Dow Jones / Finacle adapters need signed commercial
  contracts.** The adapter interface can be built; the data cannot be obtained
  in code, and a sandbox stub that renders like live screening is the failure
  mode §6 warns about.
- **E-signature and voice transcription need third-party API keys** that are
  not provisioned (see §2).

Buildable without any of the above: Regulatory Radar → config-pack diffs + SME
review queue, Elasticsearch behind the search facade, scheduled rescreening,
WORM audit storage, email automation + RFI advanced.

---

## 6. Things that will bite you

- **The four engines are now cross-vertical** (`aab8c36`):
  `POST /engines/screening`, `/doc-intel`, `/vessel/risk`,
  `GET /vessel/lookup`, `POST /radar/scan`, `GET /screening/watchlist-status`.
  Both apps use the same routes. Distinct from
  `/integrations/{country}/screening`, which calls a *regulator's* service.
- **Unknown is not clear.** `watchlist-status.entries === 0` ⇒ screening
  matches ~12 built-in samples and a genuinely sanctioned name **cannot** hit.
  Vessel `riskScore: null` ⇒ unknown. `citationEnforced: false` ⇒ unsourced.
  Never render a green state from any of these.
- **Config packs now carry `entityTypes`** (`e8758da`) — they were being
  stripped twice, by the Zod schema and by the loader's key list.
- **`verticalAttributes` MERGES on PATCH.** Send only what changed.
- **Every regulator connector is SANDBOX.** Going live needs licensing, not
  code — see `docs/REGULATOR_API_ACCESS.md`.
- Three sessions push to `meru-core-fe`. `git pull` before every commit.
