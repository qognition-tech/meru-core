# AGENTS.md — session state, read this first

Working notes for whoever picks this up (human or agent). `CLAUDE.md` holds the
architecture; this holds *what is happening right now*.

---

## 0. Where the code lives — IMPORTANT

**Work from `~/dev/meru-core` and `~/dev/meru-core-fe`.**

The copies in `~/Documents/GitHub/` are **unusable**. That path is iCloud Drive
and the account is at ~2 KB free quota, so macOS evicted file contents and they
can never rehydrate. Files report correct sizes but every read returns 0 bytes,
including `.git` objects — which is why `git` reports "not a repository" there.

Do **not** run git in the `~/Documents` copies. With the object store
unreadable, a `pull`/`checkout`/`gc` risks destroying refs rather than
recovering anything. Delete them once the quota is freed.

Everything is safely on GitHub. `~/dev` clones are current.

---

## 1. Production is DOWN

`https://meru-core.vercel.app` returns `FUNCTION_INVOCATION_FAILED` (500) on
every route including `/health`. It was healthy earlier the same day —
verified with real JSON responses from `/tenants/me/entitlements`,
`/integrations/connectors`, `/tenant/branding`, `/platform/stats`.

### What makes this hard

The process dies before anything useful is logged. Every Vercel error entry
contains only an unrelated `pg` SSL deprecation warning, plus
`Node.js process exited with exit status: 1`. `api/index.js` required the Nest
bundle at module scope, and `ConfigModule` runs Joi validation at *import*
time — so a bad env var throws before any handler or try/catch exists.

### Fixes shipped (none restored service)

| Commit | Change | Outcome |
|---|---|---|
| `940e8ef` | Joi `.empty('')` on 26 rules — an empty env var no longer fails validation | Did not fix |
| `6d9bc38` | Strip `sslmode` from Postgres URLs (newer `pg` treats `require` as `verify-full`, overriding `rejectUnauthorized:false`) | Did not fix |
| `5415b25` | try/catch + `rawBody:true` in `api/index.js` | Did not fix |
| `09f03a9` | Move requires inside `bootstrap()` so throws are catchable | Did not fix |
| `32de5b7` | **`GET /api/v1/__diag`** — pre-boot diagnostic | **← check this** |

### NEXT STEP — do this first

```bash
curl -s https://meru-core.vercel.app/api/v1/__diag
```

Returns `{node, env:{VAR: "set(N)"|"EMPTY"|"UNSET"}, distLoads}` for the DB,
JWT, cron and Stripe vars. It answers before Nest boots, so it works while the
app is down. It reports presence and length only, never values.

### Leading hypothesis

`DATABASE_APP_URL` is empty/unset in Vercel → config falls back to
`DATABASE_URL` (the Neon **owner** role, which holds `BYPASSRLS`) →
`assertRlsEnforceable()` in `src/core/tenancy/rls.datasource.ts` **throws in
production by design** rather than serve traffic that only appears
tenant-isolated → boot fails → every route 500s.

If `__diag` shows `DATABASE_APP_URL: EMPTY|UNSET`, that is the bug. Fix by
setting it to the `meru_app` connection string (regenerate with
`node scripts/provision-rls-role.js --write-env` using the owner URL).

If it shows both DB URLs set, the hypothesis is wrong — read `distLoads`
next; `MISSING` there means an esbuild bundling failure, not config.

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

**Cross-client data exposure inside a tenant.** `GET /crm/entities` has no
server-side owner filter, so a `client`-role token receives **every case in the
firm**. ImmiStack's `fetchMyCase` filters in the browser — that is
presentation, not authorisation. RLS isolates tenants from each other; it does
not isolate users within a tenant. **Fix server-side**: scope the query by
`assignedTo`/owner when the caller's role is `client`.

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

| Missing | Needed by |
|---|---|
| `GET /payments` (per-client ledger) | ImmiStack client portal. BILL bills the *firm* for Meru, not clients for services |
| `POST /payments/checkout` for a client token | `/billing/checkout` is `@Roles(platform_admin, firm_admin)` and buys the firm's tier |
| `PUT /tenants/me/entitlements` | Onboarding steps 2 & 7 — module/country pickers record a preference, not a grant |
| `GET /tenants/:id/entitlements` \| `/branding` \| `/connectors` | Dashboard tenant detail — all three are caller-tenant-scoped only |
| `POST /tenants/:id/impersonate` | Dashboard; nothing matches `/impersonat/i` in `src/` |
| `GET /jobs/status` (per-job last run) | Dashboard health; times live in an in-memory Map and `/jobs/*` is cron-secret-guarded |
| `GET /marketing/campaigns` | No MARKETING module exists |
| `GET /communications/threads` | COM is a one-way delivery log |
| Document-checklist route | Visa document requirements are config-pack data not exposed |

**Fixed already:** `GET /tenants/:id/stats` used to return zeros for other
tenants (RLS-scoped to the caller). Now requires `platform_admin` for a
different tenant and runs under `runAsGod` (`f84aff7`).

---

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

**P7–P9 — not started.** Collaboration/WebSocket, email automation + RFI
advanced, WorldCheck/Dow Jones/Finacle adapters, Regulatory Radar →
config-pack diffs + SME review queue, Elasticsearch behind the search facade,
scheduled rescreening, voice transcription, WORM audit storage, e-signature.

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
