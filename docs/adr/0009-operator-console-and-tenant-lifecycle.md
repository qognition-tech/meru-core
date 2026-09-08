# 0009 — Operator console, tenant lifecycle, and fee-schedule contracts

**Status:** Proposed — 2026-09-08. Not merged. Requires `quality` (Owen) and `secops` (Anton)
review before implementation, per `definition-of-done.md`'s auth/tenancy gate. Contracts 1 and 3
below **adopt and confirm** decisions already made in ADR 0007 (also Proposed, not merged) rather
than re-deciding them from scratch; Contracts 2 and 4 are new. Nothing here touches `src/` —
Luke implements against this contract.

**Scope:** four operator-console/lifecycle seams named directly by the dashboard's `notImplemented`
registry (`meru-core-fe/meru-dashboard/lib/api/not-implemented.ts`) and by ImmiStack's role matrix
promising a capability with no backing route.

---

## 1. Context

### 1.1 Tenant deletion exists, unwired, and cannot finish what it started

`TenantProvisioningService.deleteTenant` (`src/iam/tenant-provisioning.service.ts:333-370`,
current line numbers — content unchanged since ADR 0007 was drafted against `:320-356`) has no
controller route. Its `permanent: true` branch (`:339-352`) opens a transaction and deletes only
`User` and `Tenant` rows. Measured against the live schema: **63 of 64 public tables carry
`tenantId` and RLS** (`meru-core/CLAUDE.md` §5.1) — `crm.universal_entities`, `documents`,
`payments`, `tasks`, `audit_logs`, `communications`, `workflow_instances` and every other
tenant-scoped table would be orphaned under a `tenantId` that resolves to nothing.

`Tenant.slug` is `@Column({ unique: true })`, so the existing soft-delete branch (`status =
TenantStatus.DELETED`) blocks re-signup under the same name forever unless something releases the
slug. `TenantProvisioningService.suspendTenant` (`:302-332`) already refuses to act on a `DELETED`
tenant — confirmed in the current source, matching ADR 0007's description exactly — so `deleted` is
already treated as terminal on one side of the code; the other side (an actual delete route) does
not exist yet.

**The crux: `audit_logs` cannot be purged by the application, structurally, not just by policy.**
Migration `1755200000000-AddAuditWormEnforcement.ts` installs a `BEFORE UPDATE OR DELETE` trigger
(`app.audit_logs_worm()`) that `RAISE EXCEPTION`s on any `DELETE` and on any `UPDATE` that touches a
column other than `archived`, plus a `BEFORE TRUNCATE` statement trigger
(`app.audit_logs_no_truncate()`) that unconditionally raises. This is enforced at the trigger level
specifically **because** RLS is bypassed by `BYPASSRLS` roles and a trigger is not — so even the
migration/owner connection (`DATABASE_URL`, which holds `BYPASSRLS` per `CLAUDE.md` §5.1) cannot
delete an audit row without first `ALTER TABLE ... DISABLE TRIGGER`, a deliberate, logged DDL act,
not a code path this service could reach by accident. A "hard purge" of a tenant's audit trail is
not merely inadvisable; it is blocked by the database unless someone deliberately defeats the
control that exists to stop exactly this.

### 1.2 An operator can read another tenant's entitlements but not write them

`GET /tenants/:id/entitlements` exists on `OperatorController` (`src/iam/operator.controller.ts:96-112`),
gated by the `forTenant` helper (`:70-94`): own tenant → run directly; another tenant → require
`platform_admin` and wrap in `TenancyService.runAsGod`, audited under the **target** tenant (a
deliberate fix already in this file — filing the audit row under the operator's own tenant meant the
target firm could never see the read in its own log). `PUT /tenants/:id/entitlements` does not
exist. The dashboard already assumes this exact path: `meru-dashboard/app/platform/tenants/[id]/page.tsx:299-311`
carries a `notImplemented("PUT /tenants/:id/entitlements", { id, modules: [] })` stub with a comment
naming it "the operator twin of the self-scoped `PUT /tenants/me/entitlements`."

The self-scoped route (`tenant-provisioning.controller.ts:96-121`) calls
`TenantProvisioningService.updateOwnEntitlements` (`:556-583`), which enforces a **plan ceiling**:
`allowance = PLAN_MODULES[tenant.plan]`, and any requested module outside it is a 400 naming the
module (`:566-574`). Entitlements are **frozen onto `tenant.settings.modules` at provisioning**
(`:437`, `:579`) — deliberately, per `meru-core/CLAUDE.md` §5.5b, so a tenant's grant does not move
when a plan definition changes later.

### 1.3 Two dead dashboard registry entries: tenant documents, job runner

`meru-dashboard/app/platform/tenants/[id]/page.tsx:266-296` (`TenantDocumentsPanel`) calls
`notImplemented("GET /platform/tenants/:id/documents", [])`; the comment names the reason precisely
— rendering the *operator's own* tenant's documents as if they were the customer's would be the
"unknown rendered as a positive result" failure `CLAUDE.md` §5.2 bans, so the panel calls the
registered stub instead of a wrong answer. `meru-dashboard/app/admin/system-health/page.tsx:62-76`
(`RunJobButton`) calls `notImplemented("POST /platform/jobs/:job/run", { job, triggered: true })`,
with a comment noting `POST /jobs/:job` is `CronSecretGuard`-gated and unusable from a browser.

`PlatformController` (`src/iam/platform.controller.ts`) is the existing precedent for
platform-wide, `platform_admin`-only, `runAsGod`-wrapped reads (`GET /platform/stats`,
`POST /platform/config-packs/reload`). Neither of the two seams above has a route on it yet.

**Correction to ADR 0007 D7's description of the job runner, found while re-verifying against
current code.** 0007 states the new route "delegates to the same `JobRunService` the existing
`/jobs/:job` (machine, `CronSecretGuard`) already calls." That is imprecise in a way that matters
for implementation: `JobsController.runJobPost`/`runJobGet` (`src/jobs/jobs.controller.ts:283-292`)
call a **private controller method**, `runNamed` (`:364-386`), whose `handlerFor` (`:388+`) is a
`switch` over `JobName` closing over **nineteen** constructor-injected services
(`src/jobs/jobs.controller.ts:169-188`: `SlaWatchdogService`, `AlertRuleService`,
`SequenceRunnerService`, `BillingService`, `QueueService`, `JobProcessor`, `TaskService`,
`NotificationsService`, `AnalyticsService`, `AuditService`, `RetentionService`,
`RegulatoryRadarEngine`, `MigrateService`, `JobRunService`, `RescreeningService`,
`NotificationDispatchService`, `WatchlistIngestService`, `ScreeningEngine`,
`ConfigPackLoaderService`). `JobRunService` itself (`src/jobs/job-run.service.ts`) only **records**
outcomes (`.record(job, {status, durationMs, error?})`); it does not own the dispatch table. "One
job implementation, two front doors" is not achievable today by injecting `JobRunService`
elsewhere — the dispatch table would have to be duplicated, which is precisely the two-implementations
drift this ADR and 0007 both exist to prevent. §2.3 below specifies the extraction this requires.

**A second, non-obvious constraint: a module cycle blocks the naive placement.**
`JobsModule` (`src/jobs/jobs.module.ts:18,40`) already imports `IamModule`. `PlatformController`
lives inside `IamModule`. `IamModule` importing `JobsModule` back — to reach a dispatch service —
would close a cycle of exactly the kind `meru-core/CLAUDE.md` §8.2 already blames for one
`FUNCTION_INVOCATION_FAILED` production incident (`DocumentsModule` → `RulesModule` instead of
`RuleEvaluatorModule`). §2.3 places the new route in `JobsModule` instead, to avoid it entirely.

### 1.4 ImmiStack's role matrix promises a fee-management capability with zero backing route

`meru-core-fe/immistack/CLAUDE.md:71` — the role/capability matrix — states "Fee schedules &
payment plans" is `firm_admin` ✅, `manager` ✅. No route, DTO or service method anywhere in
`meru-core/src/` lets a tenant write to a fee schedule. What exists is read-only:
`FeeScheduleService.catalogue` / `.feesFor` / `.planFor` (`src/billing/fee-schedule.service.ts:86-97,
316-354`) read `fees[]`/`paymentPlans[]` straight from the resolved config pack via
`VerticalPackService`, and `GET /payments/plans` (`src/billing/payments.controller.ts:99-118`)
exposes exactly that read, per-tenant-vertical, to `platform_admin`/`firm_admin`/`staff`.

**A live instance of the 80/20 violation this would create if built carelessly is already sitting
in the base pack.** `packages/config-packs/verticals/immigration.json:1512-1520` declares:

```json
{ "key": "firm_professional_482", "label": "Professional fees — subclass 482",
  "kind": "firm", "amountMinor": 350000, "currency": "AUD" }
```

Every ImmiStack tenant on the unpinned base pack — i.e. every tenant that has not pinned a country
overlay — is quoted the **same** AU$3,500 professional fee for a 482 matter, because
`FeeDefinition.kind: 'firm'` (`fee-schedule.service.ts:12`) is a real, schema-supported concept for
"what the firm charges," but it is declared once, for the whole vertical, in a file every tenant of
that vertical shares. A firm's own price for its own service is not vertical vocabulary — it is
tenant data that happens to be shaped like a fee. The pack correctly owns `gov_482_primary` (a
government charge, identical for every tenant by law) and `disb_health_examination` (a third
party's price); it should never have been the place `firm_professional_482`'s amount lives, and the
`FeeDefinition.kind` field already anticipated the distinction without the storage to back it.

`PlatformRole` has exactly four values — `platform_admin`, `firm_admin`, `staff`, `client`
(`src/iam/enums/platform-role.enum.ts:22-28`, confirmed no `manager`/`agent`/`paralegal`/`partner`
members). The role matrix's finer-grained rows (`manager`, `agent`, `paralegal`, `partner`) are
practice-role tags per ADR 0001, additive on top of `PlatformRole`, not separate enforced roles —
`[UNVERIFIED: whether a `manager` practice-role tag is defined in any shipped pack's `roles[]`
today]`. This ADR gates the new write route on `PlatformRole.FIRM_ADMIN` only; extending it to a
`manager` practice-role tag is future work under ADR 0001's existing mechanism, not a blocker here.

---

## 2. Decisions

### 2.1 Contract 1 — Tenant deletion: adopt ADR 0007 D2 (soft-delete only), confirmed still current

**Decision: soft-delete only. Retire the unwired hard-purge branch rather than repair it. Do not
build a hard purge.** This is ADR 0007's D2, re-verified against current line numbers (§1.1 above)
and strengthened by the WORM trigger evidence that was not cited there: a correct hard purge cannot
exist as application code at all while `audit_logs` is expected to survive it, and it should not
exist, because the record of what happened to a tenant's data is exactly what a regulator, a
dispute, or the platform's own incident review needs to outlive the tenant's own decision (or an
operator's) to delete.

**Route.** `DELETE /tenants/:id`, `platform_admin` only, wrapped in `runAsGod`. Body:
`{ confirmSlug: string }`, must equal the tenant's current `slug` — the same "type the name to
confirm" pattern ADR 0007 specifies and the same shape used elsewhere in this product for
irreversible-looking actions.

**Service.** New `TenantProvisioningService.softDeleteTenant(id, confirmSlug)`: 404-shaped
`BadRequestException` if no such tenant (matching this service's existing convention of
`BadRequestException('Tenant not found')` in `getEntitlements`/`updateOwnEntitlements` — see §2.2's
note on why this ADR does not introduce a differently-shaped 404 here); 400 if `confirmSlug !==
tenant.slug`; 409 if already `DELETED`. On success: `status = TenantStatus.DELETED`, `deletedAt =
now()`, and `slug` rewritten to `${slug}--deleted--${id.slice(0,8)}` so the name is released for
reuse. `listAllTenants`/`getPlatformStats` gain a `status !== DELETED` default filter;
`?includeDeleted=true` on `GET /tenants` covers audit/legal lookups.

**Export-then-anonymise, not purge, is the honest answer to "how does a tenant actually leave."**
If a regulator or contract someday requires removing PII rather than merely hiding the tenant, the
correct future shape is: (a) export everything the tenant is entitled to under its own data (the
existing `GET /crm/entities/export` machinery, run once as `runAsGod` before deletion), (b) an
anonymisation pass that overwrites PII columns in place — names, emails, document contents — while
leaving row identities, dates, amounts and `audit_logs` intact, so financial and workflow history
remains reconcilable without the audit trail ever being written to, let alone deleted. **This ADR
does not build that pass** — it does not exist today, there is no enumerated list of which columns
across which of the ~63 RLS tables count as PII, and building it against an unspecified retention
requirement would be guessing at law, not architecture. Soft-delete is the complete, defensible
answer until a specific jurisdiction's requirement is in hand.

**Errors.** 400 `MER-VAL-0001` (confirmation mismatch or not-found, matching existing convention).
New: `TENANT_ALREADY_DELETED = 'MER-TENANT-0008'` in `MeruErrorCode` — additive, next number after
`TENANT_CONNECTOR_NOT_ENABLED = 'MER-TENANT-0007'` (`src/common/types.ts:80`, confirmed as the
current end of the family).

**Audit.** `runAsGod` CRITICAL entry, `context: { tenantId, slug, releasedSlug }`.

**Migration.** None — `status`, `deletedAt`, unique `slug` all already exist.

### 2.2 Contract 2 — `PUT /tenants/:id/entitlements` (operator-side): no plan ceiling, mandatory reason

**Decision: the operator route does not enforce the plan ceiling. It always requires a stated
reason, audited.** The self-service ceiling in `updateOwnEntitlements` exists to stop a tenant
awarding itself capability it has not paid for; that reasoning does not apply to the party that
defines what a plan means in the first place. Entitlements are already, deliberately, frozen data
independent of the live plan definition (§1.2, `CLAUDE.md` §5.5b) — this is precisely the
"one-off grant that should not move when the plan changes" case that data model was built for
(comping a pilot module, a support workaround, a negotiated custom deal). Requiring a full plan
upgrade first, just to hand a customer one extra module for a trial, would force a billing-plan
change to accomplish a support action — the wrong tool, used because the right one was never built.

**Route.** `PUT /tenants/:id/entitlements` on `OperatorController` (`src/iam/operator.controller.ts`),
next to `GET :id/entitlements` — the exact path the dashboard's stub already assumes
(`page.tsx:311`). **Not** routed through the shared `forTenant` helper: `forTenant` allows an
operator to act on their *own* tenant without `platform_admin`, which is meaningless for an
entitlements write (an operator's own tenant is the control-plane tenant, which carries no
customer plan) — same reasoning `OperatorController.impersonate` already uses to bypass `forTenant`
(`:164-189`). `@Roles(PlatformRole.PLATFORM_ADMIN)` directly; always `runAsGod`, audited under the
**target** tenant `id` (matching the fix already present in this controller's audit-under-target
convention, not under the operator's own tenant).

**DTO.** New `OperatorUpdateEntitlementsDto`: `modules: string[]` (same shape and validation as
`UpdateEntitlementsDto` — complete desired state, not a delta, for the identical reason: a
PATCH-style merge would make "remove this module" unexpressible) plus `reason: string`, required,
minimum 10 characters — the same bar `ImpersonateDto` already sets
(`meru-dashboard/.../page.tsx` `ImpersonateControl`'s `tooShort` check mirrors a backend minimum),
because the reason **is** the audit record for a manual override, not decoration on it.

**Service.** New `TenantProvisioningService.updateEntitlementsAsOperator(tenantId, modules, reason,
operatorId)`: same "Tenant not found" `BadRequestException` shape as `getEntitlements`
(no ceiling check — this is the one substantive difference from `updateOwnEntitlements`); core
modules re-added unconditionally, exactly as `updateOwnEntitlements` already does (`:577`), so an
operator cannot accidentally strand a tenant without `crm`/`documents` either. This still cannot
change `plan` — `PATCH /tenants/:id/upgrade` stays the only route that does, unchanged from the
self-service route's own stated limit (`tenant-provisioning.controller.ts:107`).

**No new storage for "this exceeds the plan."** The overage is always computable at read or audit
time as `modules \ (PLAN_MODULES[tenant.plan] ?? CORE_MODULES)` — a set difference against data
that already exists — so the audit entry's `context` includes a computed `overage: string[]`
alongside `{ tenantId, modules, reason }` rather than persisting a second, parallel list that could
drift from the first.

**Errors.** No new codes. `MER-VAL-0001` only if `reason` fails the length check (existing
`class-validator` → global `ValidationPipe` path, no new code needed).

**Audit.** `runAsGod` CRITICAL entry, `context: { tenantId, modules, overage, reason }`.

**Migration.** None.

### 2.3 Contract 3 — operator tenant-documents and job-runner: adopt ADR 0007 D7, with the dispatch extraction it needs

**`GET /platform/tenants/:id/documents`.** Adopting ADR 0007 D7 unchanged: on `PlatformController`,
`platform_admin`, `runAsGod`. **Metadata-only** — `id, name, fileType, originalFileName, fileSize,
mimeType, status, linkedEntityType, linkedEntityId, versionNumber, uploadedById, createdAt`
(`documents/entities/document.entity.ts`) — explicitly excluding `s3Url`, `rbac` and `aiAnalysis`
(the last may hold extracted PII text), so this route structurally cannot become a bytes path by a
later careless `select: '*'`. This is directly the storage model `CLAUDE.md` §5.1b requires: reads
are short-TTL signed URLs, never a public link, and an operator inventory has no legitimate need to
open a client's passport scan — a bytes-returning version of this route is rejected outright, not a
close call. New `DocumentAccessService.listMetadataForTenant(tenantId)` — a **distinct** method,
not a relaxed `applyScope`, so this operator path cannot be reached by accidentally passing a
non-god actor into the client-facing method. 404 `MER-TENANT-0001` if the tenant id doesn't exist.
Audit: `runAsGod` CRITICAL.

**`POST /platform/jobs/:job/run` — this is the human-operator path, replacing `CRON_SECRET`, not
adding to it, exactly as 0007 states — but §1.3's correction changes where the code has to live.**

1. Extract `JobsController`'s dispatch — `handlerFor`, `runNamed`, and the `run` timing wrapper
   (`jobs.controller.ts:364-386` plus the surrounding `run`/`handlerFor` block) — into a new
   `JobDispatchService` (`src/jobs/job-dispatch.service.ts`) in `JobsModule`, taking the same
   nineteen dependencies `JobsController`'s constructor currently holds (§1.3's list) and exposing
   one method: `runNamed(job: string): Promise<JobResult>` (404-shaped `NotFoundException` for an
   unrecognised job, unchanged behaviour — this is a mechanical, behaviour-preserving move, not a
   rewrite). `JobsController.runJobGet`/`runJobPost` become one-line delegations to it.
   `JobRunService` is unchanged — it keeps owning `.record()` and `lastRunMap()`, called from
   inside `JobDispatchService` exactly where `JobsController` calls it today.
2. Add a **new controller in `JobsModule`**, `PlatformJobsController` (`@Controller('platform/jobs')`),
   not a new method on `IamModule`'s `PlatformController` — because `JobsModule` already imports
   `IamModule` (`jobs.module.ts:18,40`), so `IamModule` importing back to reach `JobDispatchService`
   would close the exact module cycle `CLAUDE.md` §8.2 already names as a production-incident
   cause. `PlatformJobsController` needs `TenancyModule` (for `runAsGod`) imported into
   `JobsModule` — confirmed no cycle: `TenancyModule` imports only `AuditModule`
   (`src/core/tenancy/tenancy.module.ts:18-20`).
3. `POST /platform/jobs/:job/run` on `PlatformJobsController`: `@UseGuards(AuthGuard('jwt'),
   PolicyGuard)`, `@Roles(PlatformRole.PLATFORM_ADMIN)` — **not** `CronSecretGuard`, and not both:
   this is the human front door, `CronSecretGuard` stays the machine front door on the existing
   route, and neither weakens the other. Same fail-closed shape as `CronSecretGuard`, applied to
   job-name validation instead of a secret: an unrecognised `:job` is 404, never a silent no-op.
   `runAsGod`, audited under the operator's own tenant (a manual job run is a platform-wide action
   with no single target tenant, same reasoning `PlatformController.stats` already uses for the
   same shape).

**Errors.** Documents: 404 `MER-TENANT-0001`. Job runner: 404 `MER-RES-0001` unknown job.

**Audit.** Both `runAsGod` CRITICAL — documents under the target tenant `id`; job run under the
operator's own tenant, `context: { job }`.

**Migration.** None.

### 2.4 Contract 4 — runtime fee overrides: build a narrow tenant override for `kind: 'firm'` amounts only; correct the role-matrix claim for everything else

**Decision, in two parts.** (a) A firm's **own professional fee amounts** (`FeeDefinition.kind ===
'firm'`) become tenant-overridable at runtime, via a new tenant-scoped table — this closes the live
80/20 violation already sitting in the base pack (§1.4). (b) **Payment plan structure** (`paymentPlans[]`
— instalment counts, intervals, `stages[].atStep`, `blockProgressOnArrears`) and **government/
disbursement fee amounts** stay pack-owned and are **not** made runtime-editable by any tenant role.
`meru-core-fe/immistack/CLAUDE.md:71`'s "Fee schedules & payment plans" row is **half wrong** and
must be corrected to "Firm fee amounts" — payment-plan structure is coupled to `atStep`, which is
workflow vocabulary (`PackWorkflowService` materialises steps a plan's `stages[].atStep` must name,
per `config-pack-loader.service.ts`'s own validation at load time, `:154-187`); a firm changing an
`atStep` value at runtime with no corresponding workflow step would silently stop a plan's gating
from ever firing, the same "expires within 90 days that never fires" failure class `CLAUDE.md` §4.2
already names for JsonLogic. A government fee amount is not the firm's to set at all — overriding it
would misstate what the regulator actually charges, which is exactly the "sandbox result presented
as live" failure shape `CLAUDE.md` §5.2 exists to prevent, applied to money instead of a regulator
API response.

**Schema.** New table `tenant_fee_overrides`: `id` (uuid pk), `"tenantId"` (RLS-scoped, per every
other tenant table), `feeKey` (matches a pack `fees[].key`), `amountMinor` (integer), `currency`
(char(3)), `active` (boolean, default true), `updatedBy` (fk `users.id`), `createdAt`/`updatedAt`.
**New migration**, following `1754700000000-AddTenantConnectors.ts`'s pattern exactly: `ENABLE` and
`FORCE ROW LEVEL SECURITY` on the table **at creation**, not retrofitted — the class of gap this
workspace has already had to fix elsewhere. Unique constraint on `("tenantId", "feeKey")` — one
active override per fee per tenant, so "which amount is live" is never ambiguous.

**Merge point.** `FeeScheduleService.feesFor` (`fee-schedule.service.ts:316-334`) gains a lookup:
for each resolved pack `FeeDefinition` with `kind === 'firm'`, check `tenant_fee_overrides` for an
active row on `(tenantId, key)`; if present, substitute its `amountMinor`/`currency` and leave
`label`, `kind`, `basis`, `atStep`, `refundable` — everything structural — as the pack declares
them. `FeeScheduleService.catalogue` gains the same merge so `GET /payments/plans`
(`payments.controller.ts:118`) quotes what the firm actually charges, not the pack's shared default
— the read side must agree with the write side or a firm sees its old rate quoted back after
changing it, which is the same "stale positive result" failure this codebase keeps naming under a
different name each time. `arrearsBlocking` is untouched — it reasons about `paymentPlans[]`
structure, which this decision does not touch.

**Route.** `PUT /billing/fee-overrides` on a billing controller (new or `payments.controller.ts`),
`@Roles(PlatformRole.FIRM_ADMIN)` — `staff`/`client` excluded; `platform_admin` deliberately
excluded too, because a platform operator setting one firm's professional fee is a different,
unreviewed capability this ADR does not extend to (an operator wanting to help a customer fix a
fee should do it through that customer's own `firm_admin`, or a future, separately-decided
operator route — not this one, by default). Body: `{ overrides: [{ feeKey: string, amountMinor:
number, currency: string }] }` — **complete desired state**, matching `UpdateEntitlementsDto`'s
own reasoning: a caller may need to remove an override (revert to the pack default), and a
delta-only PATCH cannot express that.

**Validation, in the service, not the DTO** — because it needs the resolved pack:
`feesFor`/lookup rejects (`BadRequestException`, `MER-VAL-0001`) any `feeKey` that (a) does not
exist in the tenant's resolved pack at all, or (b) exists but is not `kind: 'firm'` — the exact
guard that keeps a firm from quietly overriding `gov_482_primary`.

**Errors.** 400 `MER-VAL-0001` for an unknown or non-firm `feeKey`. No new codes — no `MER-BILL`
family exists today (`src/common/types.ts:55-112` confirmed: only `AUTH, TENANT, VAL, RES, RATE,
SRV, EXT`), and this does not need one.

**Audit.** `AuditService` entry at `INFO` (ordinary in-tenant commercial data, not a cross-tenant
reach — same severity choice `crm.service.ts` makes for ordinary entity writes, per ADR 0007 D3's
precedent) on every write, `context: { feeKey, amountMinor, currency, previousAmountMinor }`.

**Doc correction, same commit.** `meru-core-fe/immistack/CLAUDE.md:71` row rewritten to "Firm fee
amounts (not payment-plan structure or government fees)" for `firm_admin`; `manager`'s ✅ on that
row is left as `[UNVERIFIED: whether a manager practice-role tag should also reach this route]` —
this ADR gates `FIRM_ADMIN` only and does not extend to a practice-role tag, which is ADR 0001's
mechanism to add later if the operator decides `manager` needs it.

---

## 3. Options rejected

| # | Option | Why rejected |
|---|---|---|
| 2.1 | Fix `deleteTenant`'s `permanent: true` branch to delete from every tenant-scoped table | `audit_logs` structurally refuses `DELETE`/`UPDATE`/`TRUNCATE` via the WORM trigger (§1.1) — a "fixed" hard purge would still fail on that one table, or would have to disable the trigger, which is a legal/retention decision, not a code fix |
| 2.1 | Export-then-anonymise, built now | No enumerated PII-column list across the ~63 RLS tables exists, and no jurisdiction-specific retention requirement is in hand to design against — building it speculatively is guessing at law |
| 2.2 | Keep the plan ceiling on the operator route, same as self-service | Forces a support action (comping one module) through a billing-plan change, the wrong tool for the case entitlements-frozen-at-provisioning was built for |
| 2.2 | Require no reason, since `platform_admin` already implies trust | Every other broad-reach operator action in this codebase (impersonation, ADR 0006's invite-link, ADR 0007's tenant reads) requires a stated reason precisely because the reason is what makes the audit trail legible later, not just present |
| 2.3 | Put the operator job-run route on `IamModule`'s existing `PlatformController` | Closes a module cycle: `JobsModule` already imports `IamModule` (§1.3) |
| 2.3 | Duplicate the `handlerFor` switch statement on a new controller instead of extracting it | Recreates exactly the "one job implementation, two front doors" drift risk both this ADR and 0007 exist to prevent — two switch statements diverge silently the first time a job handler changes in one and not the other |
| 2.3 | Return document bytes from the operator route, not metadata | Directly contradicts `CLAUDE.md` §5.1b's short-TTL-signed-URL-only storage model; an operator inventory has no legitimate need to open a client's passport scan |
| 2.4 | Move `firm_professional_482`-style fees into a country overlay instead of a tenant table | Still shared by every tenant that pins that overlay — the problem is one firm's price, not one country's, and a country overlay does not solve "two AU firms charge different professional fees" |
| 2.4 | Let a firm override `paymentPlans[].stages[].atStep` too | Couples a runtime edit to workflow step names the pack's own loader validates at load time (`config-pack-loader.service.ts:154-187`); a bad `atStep` at runtime would silently stop a payment gate from firing, undetected until a case proceeds unpaid |
| 2.4 | Let `platform_admin` also write fee overrides | A distinct, unreviewed capability (operator setting a customer's prices) this ADR does not extend to; route through the firm's own admin or a separately-decided operator path |
| 2.4 | Do nothing; just correct the role-matrix doc | Rejected because the violation is already live in production pack data (`firm_professional_482`, shared by every ImmiStack tenant on the base pack) — correcting the doc alone leaves every current and future ImmiStack tenant quoted the same professional fee regardless of what they actually charge |

---

## 4. Consequences

1. **2.1 and 2.4 both add schema** — `TENANT_ALREADY_DELETED` is a pure enum addition (no
   migration); `tenant_fee_overrides` is a new table with RLS from creation. Run `npm run
   rls:verify` after the fee-overrides migration specifically, not just the unit suite, per the
   standing rule that a new RLS-carrying table is exactly the class of change that check exists for.
2. **2.2 gives the operator a strictly larger reach than the tenant already has over its own
   entitlements** — no ceiling at all, versus the tenant's own plan-bounded self-service. This is
   the same shape ADR 0006 already named for the invite-link route and ADR 0007 named for
   documents/job-run: more capability for a role that already has broad reach, made concrete in a
   response body for the first time.
3. **2.3's extraction touches a file (`jobs.controller.ts`) with nineteen constructor dependencies
   and no unit test covering module wiring** — per `CLAUDE.md` §8.2, unit tests construct services
   directly and will not catch a DI fault; this specific class of refactor is exactly what shipped
   broken before (`DocumentsModule`/`RulesModule`). The extraction must be verified by booting the
   app and grepping for `Nest application successfully started`, not by a green unit suite alone.
4. **2.4 changes what `GET /payments/plans` returns for any tenant that sets an override** — a
   firm's own portal will show a different number than the shared pack default the moment it uses
   this, which is the intended behaviour but is a visible change worth naming in the frontend
   changelog, the same caution ADR 0007 gives for its `internal` task default.
5. **None of the four decisions change what a `client`-role token can reach.** All are
   `firm_admin`/`platform_admin` surfaces; this ADR does not touch client-portal authorisation.

---

## 5. What would make these decisions wrong later

| Trigger | Which decision it invalidates | What to do |
|---|---|---|
| A regulator requires provable, permanent erasure of a tenant's data within a fixed window (GDPR-style "right to erasure" reaching a jurisdiction Meru serves) | 2.1's "soft-delete only, no purge" | Design the real export-then-anonymise pass as its own ADR, enumerating every PII column across the ~63 RLS tables and stating explicitly what happens to `audit_logs` (almost certainly: anonymise the actor/subject references in place, never delete the row) — do not extend the existing broken `permanent: true` branch |
| Billing reconciliation needs to distinguish "operator-comped module" from "plan-included module" more durably than a computed set difference (e.g. for revenue-recognition reporting) | 2.2's "no new storage for overage" | Add a stored `settings.operatorGrants: string[]` at that point — additive, does not change the write contract, only adds a persisted record alongside the computed one |
| A second consumer of `JobDispatchService.runNamed` appears (e.g. a workflow step that triggers a named job directly) | 2.3's extraction | Confirms the extraction was the right call; no further action needed — this is the case the extraction was made for |
| A vertical's operator needs to read actual document content, not metadata, for a specific compliance investigation | 2.3's "metadata only" | That is a new, separately-decided, much more sensitive capability — a time-boxed, reason-required, per-document grant, not a relaxation of this route's projection |
| A second vertical (GRC) or a second ImmiStack tenant needs a `manager` practice-role tag to also write fee overrides | 2.4's "`FIRM_ADMIN` only" | Extend the route's `@Roles`/practice-role check under ADR 0001's existing tag mechanism — do not add `manager` to `PlatformRole` |
| A firm needs per-country or per-visa-subclass variation on its own professional fee (not just one flat override per `feeKey`) | 2.4's one-row-per-`(tenantId, feeKey)` model | The pack already names distinct keys per subclass (`firm_professional_482` vs. a hypothetical `firm_professional_186`) — this is expressible today by overriding each key separately; only a genuinely finer axis (e.g., per-client custom pricing) would need a schema change |

---

## 6. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| 2.1 `DELETE /tenants/:id`, `softDeleteTenant`, slug-release, list/stats filtering, `TENANT_ALREADY_DELETED` | Remove the route; revert `permanent: true` branch removal only if nothing depends on it (nothing does — confirmed unwired) | A tenant already soft-deleted keeps its rewritten slug and `deletedAt` — correct, matches the "the record of what happened is not itself reversible" stance used everywhere else in this product |
| 2.2 `PUT /tenants/:id/entitlements`, `updateEntitlementsAsOperator`, `OperatorUpdateEntitlementsDto` | Remove the route and service method | Any tenant already granted an over-plan module keeps it until an operator explicitly revokes it via the same route — reverting the route does not silently claw back a grant |
| 2.3 `JobDispatchService` extraction | Revert `JobsController` to owning `handlerFor`/`runNamed` directly; delete `JobDispatchService` | None — behaviour-preserving move |
| 2.3 `PlatformJobsController`, `POST /platform/jobs/:job/run` | Remove the controller and its `JobsModule` registration | None |
| 2.3 `DocumentAccessService.listMetadataForTenant`, `GET /platform/tenants/:id/documents` | Remove the route; the service method is additive and used nowhere else | None |
| 2.4 `tenant_fee_overrides` table, `PUT /billing/fee-overrides`, `feesFor`/`catalogue` merge | Drop the migration (`DROP TABLE tenant_fee_overrides`); remove the route; revert the merge in `FeeScheduleService` | Any tenant that had set an override loses it on rollback — confirm with affected firms before rolling back once live, same caution as ADR 0007's `internal` column |
| 2.4 role-matrix doc correction | Revert the `immistack/CLAUDE.md:71` edit | None — doc only |

**Rollback verification:** for 2.1 specifically, confirm `listAllTenants`/`getPlatformStats`'s
`status !== DELETED` filter is the only change to those two methods before reverting — reverting it
along with the route would make previously-deleted tenants reappear in the God View, a worse
regression than the one being rolled back (this is the same caveat ADR 0007 states for the identical
change; repeated here because 2.1 adopts it verbatim).
