# AGENTS.md — where Meru Core actually stands

> Current state, verified against the running system rather than against
> documentation. Architecture and rules are in [CLAUDE.md](CLAUDE.md); these two
> files are the entire documentation surface.
>
> *Last verified: 2026-08-11 — 299 unit tests green, 785 API contract checks
> passing across all 297 operations, 31,579 sanctions entries per database, ten
> config packs, all three databases on 32 migrations.*
>
> **DEPLOYED 2026-08-11.** `main` and `production` are at `c05cadc` and live at
> `meru-core.vercel.app` — 248 paths / 297 operations, 10 config packs seeded,
> 785 contract checks passing against production, tenant isolation 10/10 over
> HTTP.
>
> `npm run rls:verify` cannot be run locally: it needs `DATABASE_APP_URL`, and
> `vercel env pull` returns encrypted values **blank**, so a pulled `.env` looks
> like the variable is unset when it is not. Verify isolation against the
> deployment with `BASE_URL=… bash scripts/smoke/cross-tenant.sh`, which proves
> the same property over HTTP with two real tenants.
>
> **Additional pass, `harden/authz-golive`, 2026-09-02** — a second class of
> authorisation gap, not a redeploy: the fifth instance of "a service method
> took no actor" was found on CRM and closed, then the same access model was
> extended to tasks, queue, search, Elasticsearch, forms, workflow, audit,
> billing, notifications, analytics and orchestration. Detail in §3.0c. Two
> compensating (not root-fixed) checks and several deliberately-still-open
> findings are recorded there — do not re-discover them as new. Confirmed this
> session, against the live DB: **RLS covers 63 of 64 public tables** (the
> `migrations` table is the correct exception — no `tenantId` column); older
> text below quoting "51 tables" undercounts. `DATABASE_APP_URL` is declared
> but **empty** in the local `.env`, so `rls:verify` still cannot run locally.
> `/api-json` currently reports **272 paths** (not all of the growth since 262
> is this branch's — query it, do not carry forward either number).

---

## 1. Scope, measured

Two specifications drive this product: the GovernanceX features report (**174
rows**, marketed as "143 feature modules") and the Qognition immigration BRD
(**117 rows**). Every row was mapped onto the 14 modules, the 4 engines and the
pack schema, then checked against the live deployment.

| Verdict | GovX 174 | BRD 117 |
|---|---|---|
| Live in core | 64 (37%) | 44 (38%) |
| Config-pack authoring only, zero code | 17 | 12 |
| Pack-schema extension + generic evaluator | 15 | 17 |
| Core code, small | 39 | 15 |
| Core code, medium | 13 | 12 |
| Core code, large | 2 | 1 |
| Blocked on a credential only | 10 | 9 |
| Blocked on a commercial/government contract | 7 | 4 |
| Impossible on this deployment | 5 | 1 |
| Should not live in horizontal core | 2 | 5 |

**~47% of both specs is satisfied or needs nothing but JSON.** Only 3 rows out
of 291 are large engineering. The bottleneck was never module count — it was
that the pack schema had no vocabulary for 32 of the rows, so each could only
have been built as vertical code inside `src/`, which is the one thing that
would break the architecture.

**That bottleneck is now cleared: all nine pack arrays ship with their
evaluators** (§3), and the packs are restructured into vertical bases with
country overlays, so adding a country is one small file rather than a copy of
the whole vertical.

### 1.1 What the "143 features" document claims that is not true

A circulating "GovernanceX — Comprehensive Features Report" claims 143 feature
modules and 216 database tables, all operational, on a React 19 / Express /
tRPC / MySQL-TiDB / Drizzle stack. **That does not describe this system.** Meru
is Next.js / NestJS / Postgres-Neon / TypeORM. Of 38 named features checked
against the live spec, 4 had a backing route.

Genuinely absent: WorldCheck, Dow Jones, Finacle, adverse media, PEP, TBML
scoring beyond the current heuristics, price benchmarking, fraud-pattern
matching against history, email A/B testing, voice transcription, biometric
auth, digital certificates.

Nine of the names *do* exist as GovX pages — vendor-dd, control-testing,
risk-workshop, roadmap, knowledge-base, training, turnover, rfi, match-review —
built as UI over the generic `/crm/entities?type=X` resource. That is the
correct architecture, and it is not the described capability.

Five claims are **architecturally impossible on this deployment**, not merely
unbuilt: real-time collaboration, team chat, workspace collaboration, user
presence and collaborative editing all need a held-open connection, and Vercel
functions terminate per invocation.

If that document is being used for scoping or sales, the gap between it and the
running system is large, and the frontend is where a customer sees it.

---

## 2. The API surface

**307 operations across 257 paths.** Ten added on 2026-08-11 after the
verification pass below; none removed or renamed, so nothing built against the
previous surface breaks.

Added: `POST /crm/entities/:id/convert`, `GET /documents/templates`,
`POST /documents/generate/:templateKey`, `GET /analytics/trends/:kpiKey`,
`GET /payments/plans`, `POST /payments/schedule`, `GET /iam/users/directory`,
`GET /crm/entities/export`, and `GET`/`POST /crm/entities/:id/acceptance`.
`GET /tasks` gained `?page`/`?limit` and `GET /tasks/calendar/events` gained
`?scope` — both additive, and `data` is still the array.

### 2.0 Storage is broken in production, and it is not new

`POST /documents/upload` returns **500** —
`{"code":"MER-SRV-0001","message":"timeout exceeded when trying to connect"}` —
because no AWS credentials are configured. `meru-core-fe` lists that route as
wired and working, so this had gone unnoticed. `POST /documents/generate/:key`
without `?store=true` is unaffected and returns real PDF bytes; `?store=true`
inherits the same failure. Belongs on the credentials list in §5, not the code
list in §4.

### 2.1 What the 2026-08-11 validation pass found

Every claim in `BACKEND-HANDOFF.md` and the frontend's
`IMMISTACK-BACKEND-REQUESTS.md` was re-tested over HTTP against production. All
six contract defects the frontend reported reproduced and are fixed. Two defects
nobody had reported were found and fixed, and both were live:

1. **A `client` token read other clients' message bodies.** `/communications/*`
   was tenant-scoped, not user-scoped — the third instance of that shape after
   CRM and payments, so the check now lives in `ThreadService`.
2. **`notification-dispatch` had been dead for 34 hours.** One row with an
   address in the uuid `recipientId` column threw inside the sweep, the throw
   escaped the loop, and because the poison row is read first on every run no
   notification was delivered for any tenant.

Two documented claims turned out to be wrong and are corrected here:

- **`verticalAttributes` merged only one level deep.** BACKEND-HANDOFF said
  "merges"; the frontend said "replaces". Each was right about a different
  depth, and nested siblings were being erased. Now a real deep merge.
- **Screening escalated on noise.** An invented name scored `critical` with a
  "file a SAR" recommendation off one 0.86 match against a *vessel*. Worse, no
  genuine designation ever reached the `alert` band, so the severity distinction
  the docs describe was one the engine could not draw. Both fixed; measured
  before and after against the real 31,579 entries.

Added: pack navigation and dashboards (4), communications threads (5), record
comments (3), entity relations and blockers (4), scoring (2), import (2), TAT
(2). Three existing endpoints gained fields additively:
`watchlist-status.lists[]`, `provenance` on every regulator response, and
`threadKey`/`direction` on notifications. The frontend contract for all of it is
`meru-core-fe/BACKEND-CHANGES-2026-08-11.md`.

Counts by prefix (pre-deploy figures, for shape rather than precision):

| Prefix | Routes | Prefix | Routes |
|---|---|---|---|
| `integrations` | 45 | `notifications` | 12 |
| `auth` | 16 | `billing` | 12 |
| `tasks` | 15 | `analytics` | 11 |
| `storage` | 15 | `crm` | 9 |
| `elasticsearch` | 15 | `workflows` | 8 |
| `tenants` | 14 | `engines` | 8 |
| `config-packs` | 14 | `orchestration` | 7 |
| `queue` | 13 | `jobs` | 7 |
| `forms` | 13 | `audit` | 7 |
| `documents` | 13 | `payments` | 5 |
| | | `communications` | 5 |

`npm run smoke:sweep` walks the whole OpenAPI document against a live instance:
auth posture on every operation, envelope shape and 5xx on reads, junk-body
validation on writes, and literal/param route shadowing. It exits non-zero on
any failure, so it gates a deploy.

---

## 3. Shipped, and what each one actually fixed

### 3.0 2026-08-22 — the six gap closures

All verified by `pnpm build`, `pnpm check:cjs`, `pnpm test` (38 suites / 548).

| Gap | What shipped | Where |
|---|---|---|
| Pack `workflows[]` inert | `PackWorkflowService.materialise` → real `workflows` rows; `GET /workflows/pack`, `POST /workflows/pack/materialise` (firm/platform admin, idempotent). Step `condition` strings compile to JsonLogic (`compileCondition`, no eval); `evaluateConditions` evaluates `conditions.jsonLogic` via `RuleEvaluatorService`; an uncompilable condition is `conditions.unevaluable` and **never opens**. | `src/workflow/services/pack-workflow.service.ts`, `pack-condition.ts` |
| Country pins ignored on reads | `VerticalPackService.forVertical` honours the ambient tenant's active, same-vertical pin; base pack otherwise | `src/tenant/services/vertical-pack.service.ts` |
| `rules[]` read by nobody | `PackRuleService.evaluate` → `GET /crm/entities/:id/rules`. Read-only; `skipped` = unknown, not passed | `src/rules/pack-rule.service.ts` |
| Entitlements cosmetic | `ModuleCode` (additive), `@RequiresModule`, `ModuleEntitlementGuard` → 402 `MER-TENANT-0006`. Trade + vessel routes only; pre-vocabulary grants pass ungated | `src/iam/entitlements/` |
| No tenant-domain resolution | public `GET /tenants/resolve?host=` | `tenant-provisioning.{controller,service}.ts` |
| Search never hit Elasticsearch | `SearchService` mirrors writes and queries ES when `ElasticsearchService.available`; Postgres ILIKE fallback, same shape. `ELASTICSEARCH_HOST` is **unset on Vercel**, so production is still on Postgres | `src/search/search.service.ts` |

Live at **262 paths** after the 2026-08-22 deploy. Two import cycles bit on
the first attempt (FUNCTION_INVOCATION_FAILED on every route for ~40 min):
`CrmModule → RulesModule → Tasks → Documents → Crm`, and
`SearchModule → ElasticsearchModule → IamModule → … → Search`. Both fixed
with leaf modules (`PackRuleModule`, `ElasticsearchCoreModule`). **Boot the
compiled app locally before deploying** — `SKIP_CONFIG_PACK_LOADER=true
JWT_SECRET=x node dist/src/main.js` and grep for
`Nest application successfully started`; unit tests do not build the graph.

### 3.0b 2026-08-22, second pass — contracts, messaging, inbound webhooks

| Was | Now | Where |
|---|---|---|
| `paymentPlans[].stages[].atStep` pointed at `482-tss` step ids inside a pack whose lifecycle is `wf_visa_matter`, so `arrearsBlocking` never matched — the "freeze on non-payment" gate was silently inert | Loader **rejects** a resolved pack with a fee or stage `atStep` naming no `workflows[].steps[].id` (`danglingStepReferences`, spec-guarded). AU overlay **2.4.0** re-points `staged_482` and the four stage-gated fees at `signup_payment` / `lodgement_fee` / `decision` / `document_request` | `config-pack-loader.service.ts`, `countries/au-immigration.json` |
| `GET /search` returned `{results,total}` for a blank query and a bare array otherwise | Always `{results, total}`; `SearchResponseDto` in the spec. `total` is the count returned, bounded by `limit` | `src/search/` |
| `GET /documents/checklist` declared no response schema; `outstandingRequired` was `0` with no `entityId` | `ChecklistResponseDto`; `outstandingRequired: null` when unknown. `uploaded` / `applies` nullability documented | `src/documents/dto/checklist-response.dto.ts` |
| `POST /tasks/calendar/sync/:provider` → 200 `{success:false}` | **501** `MER-SRV-0501` | `task.service.ts` |
| Sequences had no HTTP surface | `GET /messaging/sequences` (pack definitions + live enrolment counts), `GET /messaging/sequences/:key/enrolments?status=`, `POST …/enrolments/:entityId` (enrol now; first step goes out on the next fast tick), `POST …/stop`, `GET /messaging/templates`, `POST /messaging/templates/:key/preview` (renders without sending; returns `unrendered[]`). Firm roles only | `src/notifications/messaging.controller.ts` |
| No inbound webhook receiver — Stripe's was the only inbound route | `POST /webhooks/endpoints` (firm/platform admin; `secret` returned **once**) · `GET /webhooks/endpoints` · `PATCH`/`DELETE` · `GET /webhooks/events`. Public `POST /webhooks/inbound/:endpointId` verifies `hmac-sha256-hex` / `hmac-sha256-base64` / `bearer-token` over the raw body, stores the delivery under the endpoint's tenant, emits **`webhook.inbound.received`** (`InboundWebhookReceivedPayload`) for a consumer to act on, answers 401 on a bad signature (stored as `rejected`). Scheme `none` → `signatureValid: null` — **unverified, never verified**. Two new tables, RLS ENABLE+FORCE; migration `1756300000000` | `src/webhooks/` |

Nothing here is wired to a consumer yet: a signature-provider adapter or a Cal.com sync is an `@OnEvent('webhook.inbound.received')` listener that reads `body` and acts. That is the seam; the receiver does not interpret.

### 3.0c 2026-09-02 — `harden/authz-golive`: one access model, extended past CRM

`src/common/access.ts` (`Actor`, `scopeOf` → `god | tenant | own`) shipped 2026-08-22
(`75ed8ed`) for documents and storage and, before this branch, was imported by exactly those
two services. This branch is not a list of bugs; it is that access model reaching the other
places the same shape was sitting, closing a class rather than an instance.

**New: `src/crm/crm-access.service.ts`.** CRM's own private `clientScoped()` helper had
existed since `/crm/entities` list/export were narrowed, but every by-id route —
`getEntity`, `updateEntity`, `convertEntity`, comments, acceptance, relations — reached
`CrmService` / `CommentService` / `AcceptanceService` / `EntityRelationService` methods that
took no actor at all. A `client` token that knew or guessed a UUID could read, and in several
cases modify, any other applicant's case — status, assignee, `verticalAttributes`, which on
ImmiStack is where passport and visa data lives. **This is the fifth instance** of the shape
`meru/CLAUDE.md` §16 already tracks — its own "document access control was a no-op" entry
already called itself the fourth instance, after `/crm/entities` (list only), `/payments` and
`/communications/threads` — the first one found on a resource that already had the fix
half-applied.

The fix pattern, repeated across every file below:

- `actor: Actor` is a **required** parameter, never optional. An optional actor a caller could
  forget to pass is the same bug with extra steps — the point is that the compiler now finds
  every call site.
- `own` scope is **read-only** everywhere it appears. A client's actual state changes —
  approving a draft, accepting a cost agreement, advancing a stage — go through named routes
  (`/acceptance`, `/convert`, a workflow transition) that carry their own audit trail, never a
  generic PATCH.
- Unreadable → **404, not 403.** A 403 confirms the id exists, and record ids travel in
  checklists and email links.
- `CommentService.remove` keys deletion on the **comment's author**, not the parent record's
  assignee — a client may delete their own message and nothing else.

Extended to: `crm.service.ts`, `crm.controller.ts`, `comment.service.ts`,
`acceptance.service.ts`, `entity-relation.service.ts` (CRM); `task.service.ts`,
`task.controller.ts`; `queue.controller.ts`; `search.service.ts`, `search.controller.ts`,
`elasticsearch.controller.ts`; `form.controller.ts`; `workflow.service.ts`,
`workflow.controller.ts`; `audit.controller.ts`; `billing.controller.ts`;
`notifications.controller.ts`; `analytics.controller.ts`; `orchestration.controller.ts`;
`ai.service.ts`; `tenant-id.decorator.ts`.

Specifics worth keeping:

- `?includeInternal=true` on `GET /crm/entities/:id/comments` used to be read straight off the
  query string with no role check — any client could ask for, and receive, the firm's private
  file notes on any case they could reach. It is now `&&`-ed with
  `CrmAccessService.mayReadInternalNotes(actor)` inside the service, not the controller.
- `SearchService.indexEntityData` used to trust the request body's `entity.tenantId`
  outright, and the dedup lookup matched on `searchableId` alone with no `tenantId` in the
  `WHERE` — a cross-tenant overwrite primitive on `POST /search/index/entity` and
  `/search/index/bulk`. `search_index`'s RLS policy is `cmd=ALL` with both `USING` and
  `WITH CHECK`, which is why this was a contained bug and not a live cross-tenant write —
  Postgres rejected the insert. **Do not read that as licence to trust body input**: the
  controller now derives `tenantId` server-side and passes it as `overrideTenantId`; every
  internal caller (CRM, tasks, workflow, documents, forms) is unaffected because none of them
  pass it and `entity.tenantId` is already server-derived.
- `POST /search/semantic` now 503s with `unavailableReason: 'embedding_pipeline_not_configured'`
  instead of returning a fabricated HTTP 200 off a zero-vector cosine similarity.
- `TenantId` decorator's `|| request.headers['x-tenant-id']` fallback is deleted. The JWT
  claim is non-nullable today so this never actually fired in production, but a
  caller-controlled header as a tenant-identity fallback was a cross-tenant escape waiting for
  a token minted before the claim existed. Grepped first: nothing else in `src/` read the
  header back out for tenant resolution — only CORS logging in `main.ts` and Swagger's
  documentation of it as accepted; the header itself is untouched.
- `AiService.gatherCrossModuleContext` used the unscoped `findEntityById` to pull CRM context
  into an AI prompt; it now calls the tenant-scoped, actor-checked `getEntity(id, tenantId,
  SYSTEM_ACTOR)` and degrades to "no CRM context" on a cross-tenant or deleted id rather than
  aborting the rest of the gather.

**Two compensating checks, recorded as handoff, not as closed.** Both are cross-*tenant*, not
merely cross-user, and both were fixed at the controller because the owning service file was
outside this pass's scope:

1. `src/forms/form-builder.service.ts` — `getSubmission(id)` takes **no `tenantId` at all**.
   `form.controller.ts` now fetches then checks `tenantId`/`submittedBy` and 404s
   (`assertSubmissionReadable`). The correct fix is `(id, tenantId, actor)` on the
   `DocumentAccessService` model — the controller-level check is a stopgap, not the fix.
2. `src/billing/billing.service.ts` — `getCreditBalance(subscriptionId)` and
   `generateInvoice(subscriptionId, …)` take no `tenantId`. `billing.controller.ts`
   compensates by calling the tenant-scoped `getSubscription(id, tenantId)` first and
   discarding the result. Same handoff: move the `tenantId` parameter onto the two billing
   methods themselves.

**Found, and deliberately left open — do not re-discover these as new:**

- `workflow.service.ts` `listInstances` / `listWorkflows` are still tenant-scoped only — same
  bug shape `getInstance` had before this branch, not yet fixed.
- `orchestration.controller.ts` `GET search/intelligent` and `GET entity/:id/insights` read
  tenant-wide with no ownership scoping and no `@Roles` gate — `POST agents/:id/run` and
  `GET events` in the same controller got one on this branch, these two did not.
- `SearchService.indexEntityData` always writes `SearchableType.ENTITY` regardless of caller;
  non-CRM callers (tasks, workflow, documents, forms) pass a wrapper object with no `.id`, so
  `searchableId` lands `undefined` for those writes. Pre-existing, not introduced or fixed
  here.
- `src/storage/providers/supabase.provider.spec.ts` fails a plain `tsc --noEmit -p
  tsconfig.json` — five methods referenced on `SupabaseStorageProvider` that do not exist on
  the type (`initiateMultipartUpload`, `completeMultipartUpload`, `abortMultipartUpload`,
  `getPresignedUrlForPart`, `changeStorageClass`), plus two mock-shape mismatches. **Verified
  pre-existing on this branch's base** — `git status` shows `src/storage/` untouched on
  `harden/authz-golive`. It is invisible to CI because `tsconfig.build.json` excludes
  `**/*spec.ts`, so `npm run build` never runs the check that would catch it. This is a
  handoff, not something this branch introduced or fixed.

**Also confirmed, not a regression:** every billing route (`createPlan`, `getPlans`,
`createSubscription`, `getSubscription`, `recordUsage`, `addCredits`, `getCreditBalance`,
`generateInvoice`, `getMetrics`) gained `@Roles(STAFF, FIRM_ADMIN)` on this branch —
previously reachable by any authenticated tenant user, including `client`.

### 3.1 The nine pack arrays (Layer 4 → Layer 1)

| Array | Evaluator | Fixed |
|---|---|---|
| `prompts[]` | pack-before-DB resolver | `/ai/execute` returned **HTTP 500** for every tenant — `ai_prompts` was empty and unseeded |
| `rules[]` | `RuleEvaluatorService` | three condition languages that would have disagreed about `null` |
| `alertRules[]` | `AlertRuleService` sweep | 11 separately-named alert features become one loop |
| `messaging.*` | `SequenceRunnerService` | 8 email-automation rows; `notification_templates` was empty too |
| `fees[]`, `paymentPlans[]` | schedule expander + WF payment gate | EMI, gov-fee/disbursement provenance, case freeze on non-payment |
| `scoringModels[]` | `ScoringEngine` | lead scoring, visa recommendation, risk scoring — one weighted sum |
| `relationships[]` | `entity_relations` + traversal | "what blocks this?" was unanswerable; the old jsonb column read one way only |
| `navigation[]`, `dashboards[]` | `PackUiService`, `PackDashboardService` | three hardcoded sidebars; KPIs that declared a target and computed nothing |
| `importMappings[]` | `ImportService` | no way to bring a firm's existing book of clients in at all |

**All nine ship.**

Packs are at **v2.1.0** and restructured into vertical bases + country
overlays: `verticals/{grc,immigration}.json` plus `countries/{ae,sa,qa,bh}-grc`
and `countries/{au,ca,uk,nz}-immigration` — **ten packs**. GRC carries 11 entity
types (including `obligation` and `breach`, which existed in the code enum and
in no pack); immigration carries 6, where it previously declared **zero** —
the single reason that portal needed ~30 hardcoded pages. Twelve country
workflows.

### 3.2 Tenant isolation

Implemented and verified end to end: `meru_app` non-`BYPASSRLS` role,
`ENABLE`+`FORCE` RLS, connection-level tenant binding, `npm run rls:verify` passing 10/10
against Neon. See CLAUDE.md §5.1.

**Measured against the live database 2026-09-02: 63 of 64 public tables carry RLS.** The
single exception is `migrations` — TypeORM's own bookkeeping table, no `tenantId` column,
correctly excluded. The table count moves as tables are added; **measure it, do not quote
it** — this doc previously said "51 tables" and undercounted.

### 3.3 Screening

31,579 entries per database — OFAC SDN 19,199 · EU CFSP 6,234 · UK OFSI 5,135 ·
UN Consolidated 1,011. `GET /engines/screening/watchlist-status` reports the
per-list inventory and last ingest, and names any feed not re-confirmed in 14
days as stale.

Two parser traps worth remembering, both silent:

- EU marks people `<subjectType code="person" classificationCode="P"/>`.
  Matching `code="P"` matches nothing and files every designated person as an
  organization — they still screen, so nothing looks broken.
- UK publishes one row per **alias** keyed by `Group ID`. Left unfolded, one
  person is six rows and one true match looks like six hits. Its real header is
  on the second line, and gov.uk asset URLs carry an attachment id that changes
  every publication — use OFSI's blob storage.

**The defect that only real data exposed:** with `watchlist_entries` empty,
screening had never been exercised. Once 20k rows landed, *every invented name
screened as `escalated`* — a Double Metaphone match awarded a flat 0.85, exactly
the threshold. Phonetic agreement is now corroboration only, gated behind a
Levenshtein floor (not Jaro-Winkler, whose prefix bonus cannot separate
"Margarethe Vandersloot"/"MARGARITA 1" from "mohammed ali"/"muhammad ali").
0/12 invented names flag; 40/40 real designations still hit; p95 104ms.

> **The lesson generalises: a feature whose data source is empty has not been
> tested, only executed.** It was true of `watchlist_entries`, then of
> `ai_prompts` and `notification_templates`.

### 3.4 Communications

`GET /communications/threads` — the frontend's top ask for two cycles. COM was a
one-way delivery log with no key to group on, so two ImmiStack inboxes were
stubbed, one of which had shipped a fabricated mailbox. Threads are
`channel:counterparty`, case-folded, backfilled across history with the
identical derivation in SQL; replies and new messages go out through the same
dispatcher as everything else, so a send is *recorded* even with no transport
configured.

### 3.5 Integration provenance

Every adapter response now carries `provenance: { sandbox, adapterId, regulator,
requestId, latencyMs, retrievedAt }`. The flag existed on `AdapterResponse` all
along and the controller dropped it on success, so a sandbox visa status and a
live one were byte-identical over HTTP. **Every regulator connector is still
SANDBOX** — going live needs licensing, not code (§6).

### 3.6 Sessions

Revoking a session now invalidates its access token within 60 seconds (cached
check in `JwtStrategy`). Previously logout revoked the row and nothing read it,
so the token stayed good for up to an hour — which is why `POST /auth/logout-all`
was being recommended for a suspected compromise. Refresh-token rotation was
already correctly single-use via a conditional `revokedAt IS NULL` UPDATE.

---

## 4. Not built yet, in priority order

### 4.1 Core work, no external dependency

| Item | Rows unblocked | Note |
|---|---|---|

| **Storage drivers** | 2 | Google Drive, Azure Blob; the provider interface is already right |

| **CRM importers** | 3 | HubSpot / Zoho / Salesforce — three OAuth apps, one per importer |
| **Email analytics** | 3 | delivery/open/click events, A/B assignment |
| **Fraud pattern store** | 1 | cross-tenant duplicate hashing exists; no history to match against |
| **WebAuthn / passkeys** | 1 | server-side challenge store |
| **Consultation booking** | 1 | calendar events exist; no bookable-slot model |

Shipped since the last revision of this table: the import pipeline, **XLSX import** (`ImportService.parseXlsx`, same parse → map → dry-run → commit path as CSV; `importMappings[].source` now branches on format), SLA
escalation actions, TAT recording and analytics, generic comments, outbound
webhooks, retention enforcement, **document generation** (`documentTemplates[]`
→ `pdf-lib`, a tenth Layer 4 array) and **trend analysis**
(`GET /analytics/trends/:kpiKey`).

### 4.2 Pack authoring — not engineering

This is where the immigration BRD actually lives, and it needs a domain author.

Done: immigration `entityTypes` (6), GRC `obligation`/`breach`, and the AU / CA
/ UK / NZ and AE / SA / QA / BH overlays with thirteen country workflows (AU 5, CA 3, UK 3, NZ 2; the four GRC overlays define none).

Still to author, and it is domain work rather than engineering:

- ~~Per-subclass document checklists~~ — **done.** `documentTypes[]` gained
  `appliesWhen` (JsonLogic), so one pack expresses 21 requirements that resolve
  to 11 for a 482, 10 for a 500, 12 for a 485, and 4 for a 600 visitor. A minor
  on a 500 additionally needs guardian consent; a 482 with dependents needs
  relationship evidence. Verified by resolving each.
- ~~Country-specific `alertRules`~~ — **done for AU/CA/UK/NZ**, 13 rules.
  **They still need a registered practitioner's sign-off per jurisdiction**
  before a firm relies on them; each pack records that in
  `metadata.alertRulesReview`. Every rule warns earlier than the deadline it
  watches, so a wrong threshold surfaces work sooner rather than missing it.
- **Health, tax, labour and education verticals**, if those are still on the
  roadmap. Each is one base pack.

### 4.2b Answered: should the visa lifecycle be a workflow?

**Yes.** The frontend asked, having implemented 13 stages in
`verticalAttributes.matter.stage`, and it is the right question — a stage stored
as a loose attribute has no transition rules, no SLA clock and no audit of who
moved it.

`wf_visa_matter` is now authored in `au-immigration.json` with the frontend's own
stage ids, so migration is a mapping exercise rather than a rewrite:

```
intake → cost_agreement → signup_payment → portal_access → document_request
→ [health_insurance] → drafting → client_approval → [apf] → lodgement_fee
→ lodged → decision → closed, with art_review branching off a refusal
```

**Resolved 2026-08-22.** Step `condition` strings now compile to JsonLogic
(`pack-condition.ts`) and evaluate through `RuleEvaluatorService`; the pack
workflow materialises via `POST /workflows/pack/materialise` (§3.0). The
paragraph below is kept as history of why it mattered.

~~**One thing blocks a clean migration, and it is a real gap:** no pack-declared
transition condition has ever been evaluated.~~ The pack schema types
`transitions[].condition` as a *string*, while `WorkflowService.evaluateConditions`
reads a structured `{operator, rules[]}` object that no pack ever supplies. So the
two conditional branches — `health_insurance` for 500/485, `apf` for anything but
500/600 — are recorded as prose in the pack and must be chosen by the caller. A UI
must not present them as automatic.

Fixing it means accepting JsonLogic on a transition and routing it through
`RuleEvaluatorService`, which is what every other conditional in a pack already
uses. Until then the workflow is a correct skeleton with manual branching.

### 4.3 Decisions needed from the business

| # | Decision | Recommendation |
|---|---|---|
| 1 | Realtime host for chat/presence/collaboration | **Ably** — no infra to run, works alongside serverless; five rows are not worth a second deployment target |
| 2 | Scheduler | **Upstash QStash** or cron-job.org — per-minute, retries, signed requests |
| 3 | Marketing module | **Do not build one.** Newsletters are `messaging.sequences[]`; SEO and social are not regulatory plumbing |
| 4 | AWS migration (BRD §18) | **Stay on Vercel + Neon**; revisit when a contract requires residency Neon cannot give |
| 5 | OCR | **Cloud Vision** — Tesseract on serverless is a bad fit for large scans |

---

## 5. Credentials — nothing works without these

**Free, already yours, just unset.** This is the cheapest work available
anywhere on the list and currently the largest single blocker.

| Variable | For | Consequence today |
|---|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, three price IDs | BILL | `/billing/checkout` → clean 503. **Test mode first** |
| `RESEND_API_KEY`, `RESEND_FROM` (verified sender — the code reads `RESEND_FROM`; `MAIL_FROM` does nothing) | COM | **harder than "invites are delayed": no new user can self-activate.** `POST /iam/users/invite` returns `inviteSent: false`; the invited row is created with an unusable placeholder password (`iam.service.ts` `inviteUser`, "never returned, never sent anywhere") and the acceptance link is otherwise **only in the server log** — not retrievable by a tenant admin on Vercel. There is deliberately no admin set-password route either: `UpdateUserDto` carries no `password` field, precisely so a tenant admin can never take over another user's account (`update-user.dto.ts`'s own doc comment). With this unset, the invite email is the sole path to a first login, and it never arrives. Confirmed 2026-09-02 |
| `OPENAI_API_KEY` | AI, OCR, radar | every AI feature disabled |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` (private), `STORAGE_PROVIDER=supabase` | DOC | `POST /documents/upload` → 503 `unavailableReason` (no driver credentialed). The service key bypasses Supabase RLS — CLAUDE.md §5.1b |
| ~~`CRON_SECRET`~~ **set** (verified `vercel env ls`, 2026-08-22) + an external minute-scheduler URL | queue, ingestion, **sanctions screening** | The two Vercel crons are authorised and both run **daily**. Minute-level jobs (queue drain, dispatch, SLA watchdog, alert rules) still fire once a day until QStash / cron-job.org pings `/api/v1/jobs/tick?scope=fast`. Whether the ingest has *succeeded* is a separate question — check `GET /engines/screening/watchlist-status`; until `entries > 0`, `POST /engines/screening` answers **503** `listsLoaded:false` |

### 5.1 Loading the sanctions lists — the exact commands

Screening has no URL to configure. `WatchlistIngestService` fetches the public
OFAC SDN CSV, UN Consolidated XML, EU CFSP XML and UK OFSI CSV from hardcoded
official URLs; the only things it needs are `CRON_SECRET` (so the job route
will answer) and one run. `SCREENING_LISTS_URL`, which an earlier capability
report demanded, is read by nothing — do not set it.

```bash
# 1. CRON_SECRET is already set on Production (2026-08-22). Read it with
#    `vercel env pull` is NOT enough (encrypted values pull blank) — use the
#    value from the Vercel dashboard, or rotate it with `vercel env add`.

# 2. Run the ingest once by hand. 30–90 s; returns per-list counts.
curl -X POST https://meru-core.vercel.app/api/v1/jobs/watchlist-ingest \
  -H "Authorization: Bearer $CRON_SECRET"

# 3. Confirm. `entries` must be > 0 and `lists` should name ofac, un, eu, uk_hmt.
curl https://meru-core.vercel.app/api/v1/engines/screening/watchlist-status \
  -H "Authorization: Bearer <any JWT>"

# 4. Keep it fresh: point a scheduler (cron-job.org, 1-min granularity) at
#    /api/v1/jobs/tick?scope=fast every minute and ?scope=daily once a day,
#    both with the same bearer. Until then the lists go stale after 14 days.
```

Until step 2 has run, `GET /health/capabilities` reports `screening_lists:
unconfigured` naming this section, and `POST /engines/screening` refuses with
503 `{ listsLoaded: false, unavailableReason }`. It never returns `clear` off
an empty table — the built-in sample list that used to stand in is gone.

**Paid, no negotiation** (~$20–200/mo each): Ably/Pusher · Upstash QStash ·
Twilio *or* Meta WhatsApp Cloud API (**Meta Business verification is the long
pole — start early**) · Deepgram or Whisper · Elastic Cloud · DocuSign or
Dropbox Sign · AISStream/Spire for AIS · Google Cloud OAuth · Azure storage ·
HubSpot/Zoho/Salesforce developer apps.

**Commercial contracts, cannot be coded around:** Refinitiv WorldCheck One · Dow
Jones Risk & Compliance · Finacle (needs the bank client's own environment) · an
adverse-media/PEP feed · HS-code price benchmark data.

**Government access — licensing, not code:** AU VEVO/ImmiAccount (registered
migration agent or approved integrator) · IRCC · UK Home Office right-to-work ·
NZ INZ · CBUAE Open Finance certification · SAMA · QCB.

---

> **CORS allowlist is additive (2026-08-23).** `src/common/cors-origins.ts` is the
> single list used by `src/main.ts` and `api/index.js`. `CORS_ALLOWED_ORIGINS`
> *extends* it and can no longer replace it. The Production value (set once,
> 24 days earlier) listed only the dashboard origin, so `govx-app.vercel.app`
> and `immistack-plum.vercel.app` failed preflight — "Network Error" on login.
> Add a new Vercel alias or custom domain to the file, not only to the env.

## 6. Regulator connectors — all eight are SANDBOX

| Adapter | Regulator | To go live |
|---|---|---|
| `au-home-affairs` | AU Department of Home Affairs | registered migration agent or approved integrator; VEVO is the gated part |
| `ae-cbuae` | UAE Central Bank | Open Finance certification |
| `sa-sama` | Saudi SAMA | licensing |
| `qa-qcb` | Qatar Central Bank | licensing |
| `bh-cbb` | Bahrain Central Bank | licensing |
| `ca-ircc` | Canada IRCC | licensing |
| `uk-home-office` | UK Home Office | right-to-work share-code access |
| `nz-inz` | NZ Immigration | VisaView access |

Each keeps its sandbox badge until real credentials are installed, and
`provenance.sandbox` is how the UI knows. **A UI that implies live regulator
data is the worst failure mode this product has.**

Going live for one regulator is `<ADAPTER>_SANDBOX=false` **plus** its
credentials. Either alone leaves the adapter in sandbox, deliberately: the
original rule was `NODE_ENV !== 'production' || <FLAG>`, which meant production
with no credentials declared itself **live**, aimed real requests at the
regulator, and — far worse — reported `provenance.sandbox: false` on the way
out. A missing credential can only ever mean "not licensed yet"
(`c05cadc`).

---

## 7. Things that will bite you

- **An optional `actor`/`tenantId` parameter is how this bug shape keeps recurring.** Five
  separate resources (documents, storage, `/crm/entities`, `/payments`,
  `/communications/threads`) shipped a service method that could be called with no actor and
  no tenant filter, relying on RLS or the controller to remember the check. §3.0c is the
  latest and broadest instance, and it still leaves two compensating (not root-fixed) checks
  in forms and billing, plus `workflow.service.ts` `listInstances`/`listWorkflows` and
  `orchestration.controller.ts`'s two intelligence routes with no ownership scoping at all.
  When adding a new by-id method on a tenant-scoped entity, make `tenantId` and `actor`
  required parameters from the start.
- **A change for one vertical can break another, silently.** Meru stacks —
  country modules on verticals, verticals on this core — and each layer only
  knows the one below it (`CLAUDE.md` §5.5b). The failure mode has no compile
  error and no red test: entitlements are **frozen into `tenant.settings.modules`
  at provisioning**, so a migration that rewrites module codes for GRC rewrites
  **live ImmiStack grants** as data, and the first symptom is a customer losing
  a module in production. Core changes driven by one vertical must be additive,
  must leave existing values resolving, and must be verified against a tenant of
  the vertical you were *not* working on. `@RequiresModule` in particular must
  never be retrofitted onto a route ImmiStack already calls.
- **Unit tests do not assemble the module graph.** A service can be perfectly
  tested and the app still fail to boot on a missing module import — this repo
  shipped exactly that twice. Run `npm start` and read the route table.
- **The contract sweep passes on a well-formed 503.** It checks shape and
  posture, not whether an integration returned anything real. Both adapter
  defects found so far were caught by *reading a live response*, not by a green
  suite. After any deploy, call one regulator route and look at what came back.
- **`vercel env pull` blanks encrypted values.** A pulled `.env` is not evidence
  a variable is unset in production; check `vercel env ls`.
- **`verticalAttributes` MERGES on PATCH.** Send only what changed.
- **The four engines are cross-vertical**: `/engines/screening`, `/doc-intel`,
  `/vessel/risk`, `/radar/scan`. Distinct from
  `/integrations/{country}/screening`, which calls a *regulator's* service.
- **Config packs only upgrade on a greater `version`.** Edit a pack without
  bumping it and the loader silently keeps the old one.
- **The demo tenants are `status: "trial"`**, not `"active"`, and the trial
  lapses 2026-08-22. Any UI branching on `status === 'active'` renders the wrong
  state for both, and the lapse will look like a regression.
- **Three sessions push to `meru-core-fe`.** `git pull` before every commit.
- **`~/Documents/GitHub/immistack` is not this product.** It is a separate
  35-page prototype still carrying the duplicate `/platform` console that was
  deliberately deleted. Do not develop there; the live app is
  `meru-core-fe/immistack`.
- **Vercel deploys are CLI-only.** Pushing to GitHub does nothing.
- **`POST /auth/register` was removed 2026-09-04, not repaired.** It 500'd on
  the RLS `WITH CHECK` for every caller — the write ran outside the
  `runAsSystem` bypass that wrapped its two reads, back on an unbound
  connection (`iam.service.ts`, was lines 447-471). Fixing only that scoping
  bug would have shipped a worse one: the route was `@Public()`, keyed on
  nothing but a tenant slug, and `POST /tenants/check-slug` is also public and
  anonymously confirms which slugs exist — so a "fixed" version would let
  anyone self-provision into an existing tenant they can guess the slug of,
  including another firm's or a bank's, with no invite and no role gate. No
  product app has ever called it (all three portals' `(auth)` route groups are
  login/forgot/reset only). The two supported paths — `POST /tenants/signup`
  (new workspace) and `POST /iam/users/invite` (authenticated, into your own
  tenant) — are untouched. `scripts/smoke/cross-tenant.sh`'s intra-tenant
  document-isolation block used `/auth/register` to mint cheap same-tenant test
  users and now SKIPs with a stated reason instead of failing; the scoping
  logic it exercised is still covered by
  `src/documents/document-access.service.spec.ts`. **Still true separately:**
  no new user can obtain a login by any route today — invites need
  `RESEND_API_KEY`, and there is no admin "set initial password" route. That
  gap is not this one; do not resurrect register to paper over it.

---

## 8. Frontend contract notes

Rules the frontends hold to, which the API must keep making possible:

- Zero watchlist entries renders "lists not loaded", never "no hits".
- `riskScore: null` renders grey, never green.
- `live: false` is labelled stale on the record itself, not in a page corner.
- A missing position is listed as unplottable, never drawn at 0,0.
- No mock fallback survives in a page: `?? []`, never `?? someMock`.
- Config-pack data is rendered from the pack, never hardcoded — including
  navigation, which now comes from `GET /config-packs/me/navigation`.

Modules the frontend deliberately does **not** want to call directly: `Storage`
(`/documents` wraps it), `Elasticsearch` (`/search` is the right altitude),
`Queue` (`/jobs/status` covers the need).
