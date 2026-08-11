# CLAUDE.md — Meru Regulatory Operating System

> The single source of truth for architecture, rules and operations in this repo.
> **Read this before any file edit.** Current state, gaps and what to build next
> live in [AGENTS.md](AGENTS.md) — the only other document in this project.
>
> *Last updated: 2026-08-11 (post-validation).*

---

## 1. What Meru is

A **Regulatory Operating System**: the government API layer of the internet. It
abstracts ~80% of regulatory plumbing into one horizontal engine and expresses
the remaining 20% — the vertical- and country-specific part — as **JSON config
packs**.

| Layer | What it is | Cost per new vertical |
|---|---|---|
| **Meru Core** (`api.meru.com`) | 14 horizontal modules + 4 specialist engines | one-time, built |
| **Config packs** | JSON: forms, workflows, regulators, nav, dashboards, rules | **weeks** |
| **Vertical UIs** | ImmiStack, GovernanceX, Meru Dashboard | 2–6 weeks each |

**The moat is the Common Corridor** — UAE, KSA, UK, Canada, Australia. Wire a
regulator in once and every vertical inherits it.

### Products on top of the same core

| Domain | Tier | Purpose |
|---|---|---|
| `app.meru.com` | God UI | vertical/country registration, tenant health, flags, pack publishing |
| `api.meru.com` | Core API | this repo — the 14 modules and 4 engines |
| `app.immistack.com` | Vertical UI | immigration: firm admin, staff, client portals |
| `app.governance.com` | Vertical UI | banking GRC: sanctions, trade finance, AML |

The three frontends live in a separate repo, `meru-core-fe` (Next.js 15).

---

## 2. The 14 core modules

Each is an independently reasoned NestJS module under `src/`, consumed by every
vertical through stable contracts.

| # | Code | Module | Directory | Responsibility |
|---|---|---|---|---|
| 1 | **IAM** | Identity & Access | `src/iam/` | OAuth2/OIDC, RBAC/ABAC, MFA, SAML SSO, sessions, API keys |
| 2 | **TCM** | Tenant Config | `src/tenant/`, `src/config/` | config packs, pinning, feature flags, branding |
| 3 | **CRM** | Universal Entity Manager | `src/crm/` | polymorphic entities + typed relationships |
| 4 | **SRCH** | Universal Search | `src/search/` | Postgres facade, Elasticsearch + pgvector behind it |
| 5 | **AI** | AI Orchestration | `src/ai/` | model routing, prompt library, citation enforcement |
| 6 | **WF** | Workflow | `src/workflow/` | state machine, SLA tracking, escalation |
| 7 | **FORM** | Dynamic Forms | `src/forms/` | JSON-schema rendering and validation |
| 8 | **TASK** | Tasks | `src/tasks/` | assignments, recurrence, calendar |
| 9 | **COM** | Communication | `src/notifications/` | email/SMS/WhatsApp, templates, sequences, threads |
| 10 | **DOC** | Documents | `src/documents/`, `src/storage/` | OCR, versioning, S3, checklists |
| 11 | **BILL** | Billing | `src/billing/`, `src/payments/` | Stripe (Meru→tenant), payments (tenant→client **and** firm→regulator) |
| 12 | **BI** | Analytics | `src/analytics/` | reports, widgets, pack dashboards |
| 13 | **AUD** | Audit | `src/audit/` | hash-chained, WORM-triggered logs |
| 14 | **INT** | Integrations | `src/integrations/` | government adapters, connector registry |

Supporting: `src/rules/` (JsonLogic evaluator + alert rules), `src/queue/`
(Postgres-backed jobs), `src/jobs/` (HTTP-triggered scheduled work),
`src/orchestration/` (AI agents), `src/core/` (tenancy, filters, interceptors).

**Contract rule:** every module exposes a versioned REST/OpenAPI surface.
Swagger at `/api`, spec at `/api-json`.

## 3. The four specialist engines

Cross-vertical AI capability, in `src/ai/engines/`, reachable at `/engines/*`.

| Engine | What it does | Notes |
|---|---|---|
| **Screening** 🎯 | fuzzy sanctions/PEP matching | Jaro-Winkler + Levenshtein + Soundex + Double Metaphone; **phonetic agreement is corroboration only, gated behind a Levenshtein floor** |
| **Document Intelligence** 📄 | OCR, extraction, fraud signals | EXIF, font consistency, cross-tenant duplicate hashing |
| **Regulatory Radar** 🛰️ | crawls official sources, diffs rules | target: rule change → draft pack diff in ≤24h |
| **Vessel Tracking** 🚢 | AIS decoding, geofencing, dark-period detection | real NMEA decoding; `riskScore: null` means unknown |

---

## 4. The four-layer config-injection model

This is the architectural heart. 80% is shared code; the rest is JSON.

```
LAYER 4  VERTICAL PACKS (JSON)     grc · immigration  (health · tax · labour next)
LAYER 3  COUNTRY OVERLAYS (JSON)   AE SA QA BH · AU CA UK NZ — regulators, local rules
LAYER 2  SPECIALIST ENGINES        radar · screening · doc-intel · vessel
LAYER 1  14 CORE MODULES (~80%)    IAM TCM CRM SRCH AI WF FORM TASK COM DOC BILL BI AUD INT
```

### 4.0 Vertical bases, country overlays

```
packages/config-packs/
├── verticals/     grc.json · immigration.json        ← the vertical, defined once
└── countries/     ae-grc.json · sa-grc.json · qa-grc.json · bh-grc.json
                   au-immigration.json · ca-immigration.json
                   uk-immigration.json · nz-immigration.json
```

A country overlay names its base with `extends` and states **only what is
local**: its regulators, its locales, its own workflows, any threshold it
raises. The loader resolves the chain and stores the merged result, so every
reader works without knowing inheritance exists.

Arrays merge **by identity** (`key`/`type`/`id`/`code`), not wholesale — that is
what makes an overlay worth having: `ae-grc` adds CBUAE without restating eleven
entity types. Arrays of scalars (`locales`) replace outright.

Pack `code` is `grc` for a base and `au-immigration` for an overlay.
**`vertical` must be a value in `VerticalType`** — the two disagreed once
(`banking` vs `grc`) and the GovernanceX tenant resolved to no pack at all, with
nothing logged, because "this vertical has no pack" is legitimate during
onboarding.

An unpinned tenant resolves the **base** pack (`VerticalPackService`); a tenant
that wants its country's overlay pins it explicitly. Five packs answer to
`vertical = 'grc'`, so an unordered lookup would hand a UAE bank whichever row
Postgres returned first.

### 4.1 The ten pack arrays and their evaluators

Every one is Layer 4 vocabulary read by exactly one generic Layer 1 evaluator
that has no idea which vertical it serves. **All ten are built.**

| Pack array | Evaluator | Lives in |
|---|---|---|
| `prompts[]` | prompt resolver (pack before DB) | AI |
| `rules[]` | `RuleEvaluatorService` (JsonLogic) | `src/rules/` |
| `alertRules[]` | `AlertRuleService` sweep on `/jobs/tick` | `src/rules/` |
| `messaging.templates[]` / `.sequences[]` | `SequenceRunnerService` | COM |
| `fees[]` + `paymentPlans[]` | schedule expander → payment items | payments |
| `scoringModels[]` | `ScoringEngine` — weighted sum + bands | AI |
| `relationships[]` | `EntityRelationService` → `entity_relations` | CRM |
| `navigation[]` + `dashboards[]` | `PackUiService` + `PackDashboardService` | TCM + BI |
| `importMappings[]` | `ImportService` — parse → map → dry-run diff → commit | INT |
| `documentTemplates[]` | `DocumentGenerationService` — block layout → PDF | DOC |

### 4.2 Rules for changing the pack schema

Learned the hard way, twice:

1. **Extend the Zod schema, the JSON Schema and the loader's key list in the
   same commit.** `entityTypes` was once stripped twice — by the Zod schema and
   by the loader — and before that a `code` regex mismatch rejected *every* pack
   at boot, leaving `config_packs` empty while the docs claimed Layer 3/4 was
   live. Regenerate with `npm run packs:schema`.
   `config-pack-loader.service.spec.ts` asserts every array round-trips.
2. **Every array is optional and additive.** A pack that omits one must load.
3. **No `eval`.** Conditions are `json-logic-js`: declarative, serialisable, no
   host access. An expression language in a multi-tenant pack authored by a
   non-engineer is a sandbox escape with a JSON file for a payload.
   **But JsonLogic is total over missing data, and `null < 90` is true in
   JavaScript.** A comparison against a variable the record does not carry used to
   satisfy itself, so "expires within 90 days" fired on every record with no
   expiry date. `RuleEvaluatorService` now refuses to evaluate a rule whose
   numeric comparison references an absent variable — absence stays meaningful to
   `!` and `==`, where "not yet received" is the point. When authoring a date
   rule, use only `<field>_daysUntil` / `_daysSince`: a threshold baked into the
   name (`_daysUntil365`) resolves to undefined, and before this guard that meant
   *always*, not never.
4. **Bump the pack `version`.** The loader only upgrades on a greater version.
5. **`documentTypes` and `documentTemplates` are opposites.** The first is what
   the platform *collects*, the second what it *produces*. A generated document
   that also satisfies a checklist requirement names it with `documentTypeKey`,
   or the checklist keeps asking for the document the firm just produced.

---

## 5. Non-negotiable rules

### 5.1 Strict multi-tenancy

Every tenant-scoped table has `"tenantId"` (camelCase). No query crosses tenants
without an explicit god-mode audit entry.

**How it is actually enforced** (`src/core/tenancy/`, migration
`AddTenantRowLevelSecurity`):

- The app connects as **`meru_app`**, a role *without* `BYPASSRLS`. This is the
  whole ballgame: an owner role with `BYPASSRLS` (the default for Neon,
  Supabase, RDS) ignores every policy while still reporting them as enabled.
  `DATABASE_URL` (owner) is for migrations; `DATABASE_APP_URL` is for runtime.
- Every table is `ENABLE` **and** `FORCE ROW LEVEL SECURITY` — without `FORCE`
  the table owner is exempt.
- `TenantAlsMiddleware` opens an AsyncLocalStorage context;
  `TenantBindingInterceptor` fills the tenant in after the guards run;
  `applyRlsToDataSource` sets `app.current_tenant_id` on the *same pooled
  connection* the query will use.
- Policies **fail closed**: an unbound connection matches zero rows.
- Bootstrap lookups that *establish* identity (login by email, refresh token,
  API key, session revocation check) run inside `TenantContext.runAsSystem`.
  Cross-tenant operator access goes through `TenancyService.runAsGod`, which
  writes a `CRITICAL` audit entry first.

**RLS isolates tenants, not users inside a tenant.** It is the wrong tool for
"this applicant may see only their own rows", and every resource a client-role
token can reach needs its own check. That has now been missed three times —
`/crm/entities`, `/payments`, and `/communications/threads`, where a client read
other clients' message bodies in production. When adding a resource the client
portal touches, the question is not "is RLS on" but "what confines this to one
user, and is it in the service rather than the controller".

**Never trust "RLS is on" without `npm run rls:verify`.** It attempts real
cross-tenant reads and writes and exits non-zero if any succeed.

### 5.2 Unknown is never clear

The single most important product rule, and the one most easily violated by a
well-meaning default:

- `watchlist-status.entries === 0` ⇒ screening **cannot** hit a real name.
  Render "lists not loaded", never "no hits".
- Vessel `riskScore: null` ⇒ unknown. Grey, never green.
- `citationEnforced: false` ⇒ unsourced.
- A KPI with no `metric` returns `value: null` + `unavailableReason`, never `0`.
  A percentage over an empty population is `null`, not `0%`.
- A dashboard widget whose scan hit its cap reports `truncated: true`; its count
  is a lower bound.
- Every degradable adapter response carries `unavailableReason` or
  `provenance.sandbox`. **A sandbox regulator response must never be
  indistinguishable from a live one** — a compliance officer acts on a visa
  status.
- **And the mirror image: noise must never present as a finding.** Screening an
  invented name returned `riskLevel: critical` with "file a SAR if applicable"
  on the strength of one 0.86 fuzzy match against a *vessel*. Over-escalation
  costs the same thing as under-reporting in the end — the alerts get switched
  off, and the real designation goes with them. A `warning` is a prompt for a
  human; only an `alert` is a designation.
- A generated document with a blank where a figure belongs is worse than no
  document: it looks executable and someone may sign it. `documentTemplates[]`
  declares `requires`, and generation refuses rather than filling a hole.

### 5.2b Say what a record is not

Two places now return a field whose only job is to deny a stronger claim:

- `POST /crm/entities/:id/acceptance` returns `isSignature: false`. It is an
  audited, hash-anchored record of assent — not an electronically signed
  instrument, because there is no signatory certificate, no tamper-evident
  envelope and no independent timestamp authority. "The client ticked a box" and
  "the client signed" are not the same thing, and a firm will assume they are
  unless told otherwise. Real e-signature needs a provider; it is a commercial
  decision, not an afternoon's code.
- `NotificationType.WHATSAPP` exists so a conversation can be *recorded* on it.
  There is no transport, and dispatch fails such a row explicitly rather than
  reporting `sent`.

An exported file gets the same treatment: `GET /crm/entities/export` sets
`X-Export-Truncated` when it hit its cap, because a file that is quietly a
prefix of the answer is the same lie as a truncated count reported as exact —
and worse, because it leaves the building.

### 5.3 Citations or silence

No free-form generation for regulatory answers. Every GovAI response carries
inline citations to official sources; failure to cite suppresses the response in
favour of "I don't have a verified source for this."

### 5.4 Audit everything

Every state-changing action writes to AUD with hash-chained entries.
`audit_logs` is append-only via database triggers (not RLS, which a `BYPASSRLS`
owner would evade). Only `archived` may change; DELETE and TRUNCATE are refused.
Not yet full WORM — a superuser can drop the trigger; real immutability needs S3
Object Lock export.

### 5.4b The ledger has two directions

`payments.direction` is `inbound` (a client owes the firm) or `outbound` (the
firm pays a regulator or supplier). One table, because a matter's financial
history is one list — but **never summed together**. Counting a forwarded
government charge as income overstates revenue by exactly the amount the firm
never earned, so `GET /payments/summary` reports `receivableMinor` and
`payableMinor` separately and keeps `direction` in every group key.

A client-role caller sees `inbound` only, on both the list and by id. What the
firm spends is its own business, including on that client's matter.

### 5.5 The 80/20 rule

If you are tempted to put vertical-specific vocabulary into `src/` — **stop**.
It belongs in a config pack. Core knows "a record that can be worked"; it does
not know what a visa is. This is the rule that keeps one platform from becoming
two bespoke products.

### 5.6 UI standards (for the frontend repo)

Next.js 15 App Router, Tailwind 4, shadcn/ui, Geist + Inter. Information-dense,
native micro-interactions only, dark mode first-class. Every staff portal leads
with a natural-language command bar. Navigation renders from
`GET /config-packs/me/navigation` — never hardcoded.

---

## 6. Stack

| Layer | Choice | Note |
|---|---|---|
| API | **NestJS 11**, REST + OpenAPI | Swagger `/api` |
| ORM | **TypeORM 0.3**, 32 migrations | staying — a Drizzle port buys nothing here |
| DB | **Neon Postgres**, 3 databases | `meru` (control plane), `govx`, `immistack` |
| Search | Postgres facade; Elasticsearch + pgvector available | ES optional, unwired |
| Queue | **Postgres-backed** (`queue_jobs`) | Redis is *not* required |
| Storage | AWS S3, per-tenant prefix | Google Drive / Azure drivers not built |
| AI | `langchain` + `openai` | needs `OPENAI_API_KEY` |
| Auth | JWT + Passport, TOTP MFA, SAML | sessions revocable within 60s |
| Host | Vercel `sin1`, CLI-deployed | `vercel --prod`; no git integration |

---

## 7. Repository layout

```
meru-core/
├── src/
│   ├── iam/ tenant/ config/ crm/ search/ ai/ workflow/ forms/ tasks/
│   ├── notifications/ documents/ storage/ billing/ payments/ analytics/
│   ├── audit/ integrations/ rules/ queue/ jobs/ orchestration/
│   ├── core/          # tenancy, filters, interceptors, policies
│   ├── common/        # shared types
│   ├── migrations/    # 32 TypeORM migrations
│   └── main.ts, app.module.ts
├── packages/config-packs/
│   ├── _schema/       # pack.schema.ts (Zod) + config-pack.schema.json
│   ├── ae/banking.json
│   └── au/immigration.json
├── scripts/           # db provisioning, RLS verification, smoke tests
├── CLAUDE.md          # this file — architecture, rules, operations
└── AGENTS.md          # current state, gaps, what to build next
```

---

## 8. Operations

### 8.1 Deployed

**https://meru-core.vercel.app** — Vercel `sin1`, project `meru-core`.
API `/api/v1` · Swagger `/api` · spec `/api-json` · health `/api/v1/health`.

Deploys are **CLI-driven** (`vercel --prod`); pushing to GitHub does *not*
deploy. `origin` is `qognition-tech/meru-core` (not writable by the current gh
account); `fork` → `qognitionagency/meru-core` is.

### 8.2 Before every deploy

```bash
npm run build          # must be clean
npm run check:cjs      # no ESM-only packages in the require graph
npm test               # unit suite
npm run rls:verify     # tenant isolation still holds
BASE_URL=https://meru-core.vercel.app npm run smoke:sweep
```

**"307 routes mapped" is not "it booted".** The route table is built before
providers are instantiated, so a DI fault prints a full route table and *then*
dies. A deploy went out returning `FUNCTION_INVOCATION_FAILED` on every route
because `DocumentsModule` imported `RulesModule` (which does not export the
evaluator) instead of `RuleEvaluatorModule` — with 459 unit tests green, because
every one constructs its service directly with mocked arguments and DI wiring is
precisely what they cannot see. The line to grep for is **`Nest application
successfully started`**, which only appears once every provider resolves.

**A merged commit is not a shipped one.** Deploys are `vercel --prod`; pushing
to GitHub does nothing. Check `/api-json`'s path count to know what is actually
live, and tell the frontend — `meru-core-fe/BACKEND-CHANGES-*.md` is where each
delta is handed over, and it leads with whether the change has deployed yet.

**After every deploy, call one regulator route and read the response.** The
contract sweep passes on a well-formed 503, so it cannot tell you an adapter
aimed at the real regulator and failed. Both adapter defects found to date were
invisible to a green suite and obvious in one response body.

**The sweep cannot see a wrong answer, only a malformed one.** 788 checks passed
against a build where a client could read other clients' mail, notification
dispatch had been dead for 34 hours, and screening recommended filing a SAR on a
vessel-name collision. All three were well-formed 200s. Two things catch this
class of fault and nothing else does: reading `/jobs/status` for a `lastError`,
and calling the interesting routes as each role and looking at the body. A
generated artefact — a PDF, a chart — must actually be opened; "valid PDF" and
"correct document" are different claims, and rendering the real templates is
what exposed `?` in place of every em dash.

`rls:verify` needs `DATABASE_APP_URL`, which cannot be read back out of Vercel —
`vercel env pull` returns encrypted values blank. Against a deployment, use
`BASE_URL=… bash scripts/smoke/cross-tenant.sh`, which proves the same property
over HTTP with two real tenants.

**`check:cjs` is not optional.** Vercel's CommonJS loader cannot `require()` an
ES module at all, so one ESM-only package anywhere in the graph returns
`FUNCTION_INVOCATION_FAILED` on *every* request — and it works perfectly on
local Node, so nothing else catches it. It has bitten twice: `uuid`, then
`otplib` v13 via `@scure/base`.

### 8.3 Database

```bash
node scripts/provision-rls-role.js --write-env   # create meru_app, write DATABASE_APP_URL
npm run migration:run                            # apply migrations (idempotent)
npm run rls:verify                               # prove isolation
```

All three databases sit on the **same Neon endpoint**
(`ep-restless-thunder-azgspl7m`) — `govx` and `immistack` are database names, not
separate projects — so the owner URL reaches all three. Run migrations against
each by overriding `DATABASE_URL` with `GOVX_DB_URL` / `IMMISTACK_DB_URL`.

If the schema was created outside TypeORM the `migrations` table is empty and
TypeORM replays `InitialSchema`, failing `42P07`. Baseline once:
`node scripts/baseline-migrations.js --apply --through 1744010000000`.

If `DATABASE_APP_URL` is unset the app boots on `DATABASE_URL`, logs a loud
error, and **refuses to start under `NODE_ENV=production`**.

### 8.4 Scheduled jobs on serverless

`@Cron` never fires on Vercel and the queue's polling loop is disabled under
`VERCEL`. Every scheduled job is therefore also an HTTP route under `/jobs`,
behind `CronSecretGuard`, which fails closed when `CRON_SECRET` is unset. They
accept GET as well as POST because Vercel Cron only issues GET.

| Route | Runs |
|---|---|
| `/jobs/tick?scope=fast` | queue-drain, scheduled-jobs, recurring-tasks, scheduled-notifications, sla-watchdog, scheduled-reports |
| `/jobs/tick?scope=daily` | daily-billing, regulatory-radar, audit-archive, digest-emails, watchlist-ingest, rescreening |
| `/jobs/<name>` | one job by name |

`/jobs/tick` is cadence-aware and idempotent. Dispatch stops after 45s and
reports the rest as `deferred`, so a slow job cannot exceed the function
timeout.

**Vercel Hobby allows two daily crons**, which cannot drain a queue. Point a
free external scheduler (cron-job.org, 1-minute granularity) at
`/api/v1/jobs/tick?scope=fast` with `Authorization: Bearer <CRON_SECRET>`.
**Until that exists, minute-level work runs twice a day.**

### 8.5 Serverless constraints

- Filesystem is read-only outside `/tmp`; anything writing at module init kills
  bootstrap before a route registers (hence `memoryStorage()` for uploads).
- Static assets are not traced into the bundle. Files read by path must be in
  `vercel.json` → `functions.includeFiles`. `packages/config-packs/**` and
  `swagger-ui-dist/**` are there; drop either and packs stop seeding or the docs
  page renders blank.
- **No held-open connections.** Functions terminate per invocation, so
  WebSockets, presence and collaborative editing are impossible here. They need
  a separate always-on service or a hosted realtime provider.

---

## 9. North-star metrics

| Metric | Target |
|---|---|
| Time to launch a new vertical | ≤ 6 weeks |
| Time to onboard a new country | ≤ 3 weeks |
| Feature code shared across verticals | ≥ 80% |
| AI response citation coverage | 100% |
| Radar lag (rule change → draft pack) | ≤ 24 hours |
| Tenant data-isolation incidents | **0 (ever)** |

---

## 10. Agent instructions

1. **Read this file, then [AGENTS.md](AGENTS.md).** Always, before any edit.
2. **80/20:** vertical vocabulary goes in a config pack, never in `src/`.
3. **Schema first:** new entity → TypeORM entity + migration with RLS policy +
   DTO with `class-validator` → then service and controller. Register the entity
   in `src/config/entities.ts`.
4. **Citations or silence** for anything AI-generated about regulation.
5. **One concern per commit.** Never mix a core change with pack authoring.
6. **Verify by running it.** Unit tests construct services directly and will not
   catch a module-wiring fault — `npm start` and read the route table. This repo
   has shipped a commit that did not boot.
7. **Update CLAUDE.md and AGENTS.md in the same commit as the change they
   describe.** These two files are the whole documentation surface; there is no
   third place to put it.
