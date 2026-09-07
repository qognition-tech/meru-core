# CLAUDE.md — Meru Regulatory Operating System

> The single source of truth for architecture, rules and operations in this repo.
> **Read this before any file edit.** Current state, gaps and what to build next
> live in [AGENTS.md](AGENTS.md) — the only other document in this project.
>
> *Last verified 2026-09-05.*

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
| `app.govx.com` | Vertical UI | banking GRC: sanctions, trade finance, AML |

The three frontends live in a separate repo, `meru-core-fe` (Next.js 15).

---

## 2. The 14 core modules

Each is an independently reasoned NestJS module under `src/`, consumed by every
vertical through stable contracts.

| # | Code | Module | Directory | Responsibility |
|---|---|---|---|---|
| 1 | **IAM** | Identity & Access | `src/iam/` | OAuth2/OIDC, RBAC/ABAC, MFA, SAML SSO, sessions. **No API-key auth** — `api_keys` is a dead table (see its entity); Swagger no longer advertises `x-api-key` |
| 2 | **TCM** | Tenant Config | `src/tenant/`, `src/config/` | config packs, pinning, feature flags, branding |
| 3 | **CRM** | Universal Entity Manager | `src/crm/` | polymorphic entities + typed relationships |
| 4 | **SRCH** | Universal Search | `src/search/` | Postgres facade, Elasticsearch + pgvector behind it |
| 5 | **AI** | AI Orchestration | `src/ai/` | model routing, prompt library, citation enforcement |
| 6 | **WF** | Workflow | `src/workflow/` | state machine, SLA tracking, escalation |
| 7 | **FORM** | Dynamic Forms | `src/forms/` | JSON-schema rendering and validation |
| 8 | **TASK** | Tasks | `src/tasks/` | assignments, recurrence, calendar |
| 9 | **COM** | Communication | `src/notifications/` | email/SMS/WhatsApp, templates, sequences, threads |
| 10 | **DOC** | Documents | `src/documents/`, `src/storage/` | OCR, versioning, S3, checklists |
| 11 | **BILL** | Billing | `src/billing/` (payments live inside it — there is no `src/payments/`) | Stripe (Meru→tenant), payments (tenant→client **and** firm→regulator) |
| 12 | **BI** | Analytics | `src/analytics/` | reports, widgets, pack dashboards |
| 13 | **AUD** | Audit | `src/audit/` | hash-chained, WORM-triggered logs |
| 14 | **INT** | Integrations | `src/integrations/` | government adapters, connector registry |

Supporting: `src/rules/` (JsonLogic evaluator + alert rules), `src/queue/`
(Postgres-backed jobs), `src/jobs/` (HTTP-triggered scheduled work),
`src/orchestration/` (AI agents), `src/core/` (tenancy, filters, interceptors),
`src/health/` (liveness + the capability report, `GET /health/capabilities`).

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

### 4.1 The nine pack arrays and their evaluators

Every one is Layer 4 vocabulary read by exactly one generic Layer 1 evaluator
that has no idea which vertical it serves. **All nine are built.** A tenth,
`rules[]`, is accepted by the schema and stored by the loader but **read by
nobody** — `RuleEvaluatorService` is the JsonLogic engine that `alertRules[]`
and `scoringModels[]` call; it does not walk `pack.rules`. Do not author into
`rules[]` expecting an effect.

| Pack array | Evaluator | Lives in |
|---|---|---|
| `prompts[]` | prompt resolver (pack before DB) | AI |
| `alertRules[]` | `AlertRuleService` sweep on `/jobs/tick` (JsonLogic via `RuleEvaluatorService`) | `src/rules/` |
| `messaging.templates[]` / `.sequences[]` | `SequenceRunnerService` | COM |
| `fees[]` + `paymentPlans[]` | schedule expander → payment items | payments |
| `scoringModels[]` | `ScoringEngine` — weighted sum + bands | AI |
| `relationships[]` | `EntityRelationService` → `entity_relations` | CRM |
| `navigation[]` + `dashboards[]` | `PackUiService` + `PackDashboardService` | TCM + BI |
| `importMappings[]` | `ImportService` — parse (CSV or XLSX) → map → dry-run diff → commit | INT |
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
  whole ballgame: an owner role with `BYPASSRLS` — which is exactly what Neon
  hands you as `neondb_owner` — ignores every policy while still reporting them
  as enabled.
  `DATABASE_URL` (owner) is for migrations; `DATABASE_APP_URL` is for runtime.
- Every table is `ENABLE` **and** `FORCE ROW LEVEL SECURITY` — without `FORCE`
  the table owner is exempt.

  > **Measured against the live database 2026-09-02: 63 of 64 public tables carry
  > RLS.** The single exception is `migrations`, TypeORM's own bookkeeping table,
  > which has no `tenantId` column — correctly excluded, not a gap. Earlier docs
  > quoting "51 tables" undercount; the number moves as tables are added, so
  > **measure rather than quote it**:
  >
  > ```sql
  > SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
  > FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  > WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
  > ```
  >
  > A policy's **`WITH CHECK`** clause matters as much as its `USING` clause, and
  > only `WITH CHECK` constrains writes. `search_index` carries `cmd=ALL` with
  > both, which is why `POST /search/index/entity` taking `tenantId` from the
  > *request body* was a contained bug and not a cross-tenant write — Postgres
  > rejects the insert. **Do not read that as permission to trust body input:**
  > the route now derives the tenant server-side, because a policy is the last
  > line of defence and not the first.
- `TenantAlsMiddleware` opens an AsyncLocalStorage context;
  `TenantBindingInterceptor` fills the tenant in after the guards run;
  `applyRlsToDataSource` sets `app.current_tenant_id` on the *same pooled
  connection* the query will use.
- Policies **fail closed**: an unbound connection matches zero rows.
- Bootstrap lookups that *establish* identity (login by email, refresh token,
  session revocation check) run inside `TenantContext.runAsSystem`.
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

### 5.1b Object storage: the key prefix is the only wall

The Supabase driver (`src/storage/providers/supabase.provider.ts`) holds the
**service-role key**, and the service-role key **bypasses Supabase's own
row-level security** on `storage.objects`. Supabase enforces nothing between
tenants. The **only** isolation barrier is the app's own `tenants/<tenantId>/`
key prefix, and the rules that follow from that are not optional:

- **Every key a driver touches is asserted server-side** to start with the
  caller's `tenants/<tenantId>/` — `StorageService.assertTenantKey`, on every
  read, write, copy, delete and URL. `DocumentsService` reaches storage only
  through `StorageService.putObject / getObject / signedReadUrl`; there is no
  second path to a driver, and no module may import an object-store SDK
  outside `src/storage/`.
- **The bucket is private.** `getPublicUrl` is never called. Reads are served
  by **short-TTL server-signed URLs** — default 5 minutes, hard cap 15 — and
  the driver clamps whatever a caller asks for.
- **The anon key is never used** and there is no browser-side storage path.
- Multipart upload and storage classes are S3 concepts. The Supabase driver
  does not implement them; `StorageService` reports the operation unsupported
  for that provider rather than pretending it happened.
- A driver registers only when it has credentials. Two credentialed drivers
  need `STORAGE_PROVIDER` to choose; none means every upload is a 503 with the
  variable named, never a hang against a bucket nobody created.

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

### 5.5b One engine, many verticals — the stacking rule

Meru stacks, and each layer may only know about the one below it:

```
        country modules      ae-grc · au-immigration · uk-immigration …
              ↑              only what is LOCAL: regulators, locales, thresholds
          verticals          grc.json · immigration.json
              ↑              the vocabulary: entity types, workflows, navigation
          MERU CORE          14 modules + 4 engines — this repo
                             knows "a record that can be worked". Nothing else.
```

Core is the engine. Verticals are built **on top of** it, and country modules on
top of the verticals. A vertical never reaches sideways into another vertical,
and core never reaches upward into either.

**The rule that follows: a change made for one vertical must not break another.**
GovernanceX work that damages ImmiStack has broken the product, not a portal.
This is the whole premise — if verticals can break each other, there is no
horizontal core, only two bespoke products sharing a database.

So, before changing anything in `src/`:

1. **Ask whether it belongs in a pack instead.** Usually it does (§5.5).
2. **If it must be core, make it additive.** Extend; do not replace. Existing
   values keep resolving.
3. **Verify against a tenant of a vertical you were not working on.** Not the
   one you are building for — the other one.

**The worked example — the entitlement vocabulary.** **Shipped 2026-08-22, GRC
routes only.** `src/iam/entitlements/` now holds `ModuleCode`, `@RequiresModule`
and `ModuleEntitlementGuard` (→ HTTP 402 `MER-TENANT-0006`), applied to
`/integrations/trade*`, `/integrations/vessel*` and `/engines/vessel/*` —
deliberately **not** to `/engines/screening`, which ImmiStack calls. Read what
follows as the template this change followed, not as hypothetical machinery.

Replacing the module codes with a GRC price book looked like a rename. It was not.
Every tenant carries six `CORE_MODULES` — `crm, cases, tasks, documents,
payments, communications` — and the plan tiers add `forms, ai_automation,
advanced_analytics, marketing, branding, api_access, sso` on top. ImmiStack
tenants are live on those, and entitlements are **frozen into
`tenant.settings.modules` at provisioning** (deliberately — a tenant's grant must
not move when a plan definition changes). A migration that rewrites those codes rewrites **live
immigration grants**, and it does so *silently*, because the grant is data, not
code: nothing fails to compile, no test goes red, and the first symptom is a
customer losing a module in production.

Handled correctly, that change is:

- new `ModuleCode` values **additive**, with the old codes still resolving;
- `@RequiresModule` applied **only to GRC routes** — never retrofitted onto a
  route ImmiStack already calls;
- the migration **reversible, and verified against an immigration tenant**
  before it touches anything;
- the frontend sweep re-run **after every change**, not once at the end.

Treat that as the template for any core change driven by one vertical's needs.

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
| ORM | **TypeORM 0.3**, 36 migrations | staying — a Drizzle port buys nothing here |
| DB | **Neon Postgres**, 3 databases | `meru` (control plane), `govx`, `immistack` |
| Search | Postgres facade; Elasticsearch + pgvector available | ES optional, unwired |
| Queue | **Postgres-backed** (`queue_jobs`) | Redis is *not* required |
| Storage | **Supabase Storage** or S3, per-tenant prefix (§5.1b) | `STORAGE_PROVIDER=supabase\|s3`; GCS / Azure not built |
| AI | `openai` SDK directly against any OpenAI-compatible endpoint — `langchain` is **not** a dependency | golden-rule default is **DeepSeek** (ADR 0003); platform fallback reads `AI_BASE_URL`/`AI_API_KEY`/`AI_DEFAULT_MODEL`; `DEEPSEEK_API_KEY` is not yet read by any code path — the ADR precedes the wiring |
| Auth | JWT + Passport, TOTP MFA, SAML | sessions revocable within 60s |
| Host | Vercel `sin1`, CLI-deployed | `vercel --prod`; no git integration |

---

## 7. Repository layout

```
meru-core/
├── src/
│   ├── iam/ tenant/ config/ crm/ search/ ai/ workflow/ forms/ tasks/
│   ├── notifications/ documents/ storage/ billing/ analytics/ health/
│   ├── audit/ integrations/ rules/ queue/ jobs/ orchestration/
│   ├── core/          # tenancy, filters, interceptors, policies
│   ├── common/        # shared types, Actor/scopeOf (access.ts)
│   ├── migrations/    # 36 TypeORM migrations
│   └── main.ts, app.module.ts, swagger.ts
├── packages/config-packs/
│   ├── _schema/       # pack.schema.ts (Zod) + config-pack.schema.json
│   ├── verticals/     # grc.json · immigration.json  (Layer 4 bases)
│   └── countries/     # ae-grc · sa-grc · qa-grc · bh-grc ·
│                      # au- · ca- · uk- · nz-immigration  (Layer 3 overlays)
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
deploy. There is one remote, `origin` → `qognitionagency/meru-core`.

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

Fifteen jobs, in `JOB_CADENCE_MINUTES` (`jobs.controller.ts`):

| Route | Runs |
|---|---|
| `/jobs/tick?scope=fast` | queue-drain, scheduled-jobs, recurring-tasks, scheduled-notifications, notification-dispatch, sla-watchdog, alert-rules, messaging-sequences, scheduled-reports |
| `/jobs/tick?scope=daily` | daily-billing, regulatory-radar, audit-archive, watchlist-ingest, rescreening, digest-emails |
| `/jobs/<name>` | one job by name — e.g. `POST /jobs/watchlist-ingest` (AGENTS.md §5.1) |

`/jobs/tick` is cadence-aware and idempotent. Dispatch stops after 45s and
reports the rest as `deferred`, so a slow job cannot exceed the function
timeout.

**Vercel Hobby allows two daily crons**, which cannot drain a queue. Point a
free external scheduler (cron-job.org, or Upstash QStash per ADR 0004,
1-minute granularity) at `/api/v1/jobs/tick?scope=fast` with
`Authorization: Bearer <CRON_SECRET>`.

**`CRON_SECRET` IS SET on Vercel Production** (verified `vercel env ls`,
2026-09-05) — the two Vercel crons are authorised and both run. But both are
**daily**, so until an external minute-level scheduler exists, queue drain,
notification dispatch, the SLA watchdog and alert rules only fire once a day
instead of every minute. Whether the daily jobs have actually *succeeded* is a
separate question — check `GET /jobs/status` and, for screening specifically,
`GET /engines/screening/watchlist-status` before trusting a result (§16).

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

### 8.6 `api/index.js` is a second bootstrap, and it can drift from `src/main.ts`

Vercel serves every route through `api/index.js`, which loads the compiled `dist/`
output and hand-mirrors `main.ts`'s middleware stack (§10). Two things live only
there, not in `main.ts`, and both have needed a fix:

- **`GET /api/__diag`** — a diagnostic route that returned secret **lengths**
  unauthenticated in production (`env: {JWT_SECRET: "set(40)", ...}`), and whose
  `?db=1`/`?boot=1` query params opened a live DB connection or a full app
  bootstrap inside the request, also unauthenticated. **Fixed 2026-09-05**: the
  handler is gated behind a hermetic bearer check before the `req.url.includes`
  branch does anything, and reports "set/unset" rather than exact lengths.
  `test/api-diag.e2e-spec.ts` (8/8) covers it.
- **Rate limiting** — `src/main.ts` runs `express-rate-limit`; `api/index.js` did
  not, so **production had zero brute-force protection on any `/auth/*` route**.
  An interim in-memory limiter now runs directly in `api/index.js`'s bootstrap
  (`test/api-ratelimit.e2e-spec.ts`, 3/3), fail-open by design until Upstash
  lands per **ADR 0004** — a per-invocation in-memory limiter cannot share state
  across Vercel's concurrent function instances, so treat it as a speed bump, not
  a durable control, until `@upstash/ratelimit` replaces it.

**When touching either file, touch both, or run the compiled app locally**
(`SKIP_CONFIG_PACK_LOADER=true JWT_SECRET=x node dist/src/main.js`) and grep for
`Nest application successfully started` — unit tests do not exercise `api/index.js`
at all.

### 8.7 AI provider — DeepSeek is the golden-rule default, not yet wired

`ai.service.ts`'s `clientFor()` already resolves a **per-tenant** OpenAI-compatible
provider (`baseUrl`, `apiKey`, `model`) via `ConnectorsService.resolveAiProvider` /
`PUT /integrations/connectors/openai`. What is missing is the **platform fallback**:
today it reads only `OPENAI_API_KEY`, and `DEEPSEEK_API_KEY` is read by nothing in
`src` — grepped, zero hits. **ADR 0003** (`docs/adr/0003-*.md`, Proposed) is the
contract: a `platform_ai_settings` table (encrypted, DeepSeek default,
`PUT /platform/ai-provider`, configured from `meru-dashboard`), `doc-intel.engine.ts`
routed through `clientFor` (it currently bypasses it), and embeddings split out as
their own capability — **DeepSeek has no embeddings API**, so `createEmbedding`
keeps calling `text-embedding-3-small` regardless of which chat model is active.
Until the ADR is implemented, every AI surface answers "not connected" with no
platform credential set, and packs still pin `gpt-4o-mini` as the default model.

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

---

## 11. TODO — open work

Full cross-repo list lives in `../meru-core-fe/CLAUDE.md` §10. This is the
backend half. State as of **2026-08-21**.

### RESOLVED — the toolchain works; the repo had to leave iCloud

`npm run build`, `npm test` and even `check:cjs` were dying with
`ETIMEDOUT (errno -60)` reading a `node_modules` file, and later stopped
producing any output at all.

Two causes, and only the second is durable. A **corrupt, partial `node_modules`**
was real and is fixed by `rm -rf node_modules && pnpm install --frozen-lockfile`.
But the recurring one was **iCloud**: this repo lived under `~/Documents`, which
Desktop & Documents Folders syncs, and with the account out of space the `bird`
daemon serialised every filesystem operation behind itself. An earlier revision
of this paragraph asserted "`~/Documents/GitHub` is not cloud-managed" on the
strength of `mdls` returning `(null)` — that inference is wrong, because `mdls`
only marks *evicted* files and these were materialised. **The workspace now lives
at `~/dev/meru`. Do not move it back.** Detection and the full ordering are in the
workspace `CLAUDE.md` §14; the one-line check is
`ps -eo pid,time,%cpu,comm | grep '[b]ird'`.

**Verified 2026-09-07, from `~/dev/meru`, on `main` after the merge:**
`pnpm install --frozen-lockfile` **3.6 s** · `npm run build` (`nest build`)
**clean, 8.7 s** · `npm run check:cjs` **clean, 52 packages, no ESM-only deps** ·
`npm test` **56 suites / 789 tests, all pass, 4 s**.

Ten of those tests were failing when `main` was first merged, and had been
invisible because Jest could not be scheduled on this host at all: both
`document-access.service.spec.ts` and `workflow-list-scoping.spec.ts` still
mocked the CRM repository as `find({ where: { assignedTo } })` after
`ownedEntityIds` was rewritten to build a query. The mocks are now query-builder
stubs and cover subject ownership directly.

Two gates need environment rather than code:

- **`rls:verify`** needs `DATABASE_APP_URL`, which is unset locally. Isolation is
  therefore proven as code and migration, not as observed behaviour.
- **Boot stops at the RLS assertion, correctly.** `DATABASE_URL` points at
  `neondb_owner`, which holds `BYPASSRLS`, so the app refuses to start rather
  than serve traffic that only appears tenant-scoped — the fail-closed behaviour
  §5.1 describes, working as designed. `JWT_SECRET` is also empty in `.env`.

### Open

- [x] **Capability report.** `src/health/capabilities.service.ts`,
      `GET /health/capabilities` (platform_admin), counts-only summary on the
      public `/health`, 8 unit tests. **Built, tested and route-mapped.**
- [ ] **`ModuleCode` + `@RequiresModule` + 402 `MER-ENT-0001`.** Neither symbol
      exists today; entitlement codes are plain strings in
      `tenant-provisioning.service.ts:48-75`. This is the change §5.5b is about —
      additive only, old codes keep resolving, GRC routes only, migration
      reversible and **verified against an immigration tenant before it runs**.
- [ ] Seed the price book · monitored-entity meter (snapshot, never increment) ·
      GRC pack module gating + `screening.monitoredTypes[]` · workflow JsonLogic
      conditions. (XLSX import is done: `exceljs`, same pipeline, `check:cjs`
      clean — `POST /integrations/import/:key` takes `xlsx` as base64.)
- [x] `sar` is an `EntityType` (migration `AddSarEntityType`, workable). The
      GovX pack still needs an `entityTypes[]` entry for it — pack authoring,
      separate commit — before the SAR page renders labels and fields.
- [ ] Drop the dead `storage_provider` column (`DEFAULT 'supabase'`, read by
      nothing) in a **new** migration. Do not edit the applied one.
- [ ] Remove the `governancex.com` CORS entries once DNS has moved to
      `app.govx.com` — not before, or the cutover breaks anyone on the old origin.
      `tenant-context.middleware.ts` also still hardcodes `api.governancex.com`
      in its domain map (cosmetic; that middleware no longer does tenancy work).
- [ ] Write `../meru-core-fe/BACKEND-CHANGES-<date>.md`, leading with whether it
      has shipped. A merged commit is not a shipped one.

### Storage — decision made, credentials not yet set

`src/storage/providers/` holds `s3.provider.ts` and `supabase.provider.ts`, both
real; `StorageDriverRegistry` registers only the one(s) with credentials present
and `documents.service.ts` goes through `StorageService` and imports no SDK
directly. Security model is §5.1b. **The operator has chosen Supabase Storage**
(2026-09-05) — fewer required vars (2 vs S3's 3, plus a defaulted bucket name).
Inventory on 2026-08-22: **0 `document_versions`, 0 `storage_files`** across all
three databases — uploads had been 500ing, so nothing is stored anywhere and
there is nothing to migrate.

- [ ] Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (never the anon key),
      `SUPABASE_STORAGE_BUCKET` optional, defaults to `meru-documents` (create the
      bucket **private**). `STORAGE_PROVIDER` is not needed with exactly one
      driver configured. **Verified 2026-09-05: neither driver is configured on
      Production today** — only `AWS_REGION` is set — so every upload still
      answers a clean 503 naming the missing vars.
- [ ] Once Supabase is confirmed as the permanent answer, drop `aws-sdk` and
      `s3.provider.ts` in one commit. Kept until then because removing a driver
      is a decision, not a cleanup, and S3 is not yet formally ruled out.

### Doc drift found by audit

Fixed 2026-08-22: `src/payments/`, `src/health/`, migration count, the §7
pack tree, the 15-job tick table, the remotes, `langchain`, the ten→nine pack
arrays, thirteen country workflows (counted: AU 5, CA 3, UK 3, NZ 2). Still
open: tenancy code cites "§6.4" for a rule that lives at §5.1.
