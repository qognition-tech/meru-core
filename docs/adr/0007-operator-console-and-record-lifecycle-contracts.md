# 0007 — Operator console and record-lifecycle contracts

**Status:** Proposed — 2026-09-05. Not merged. Requires `quality` (Owen) and `secops` (Anton)
review before implementation, per `definition-of-done.md`'s auth/tenancy gate — this ADR closes
one confirmed cross-tenant read (D3) and one confirmed dead-guard authz gap (D4).

**Scope:** eight contracts raised by Owen's production CRUD sweep
(`meru-core-fe/tools/sweep/report/crud.json`, defects 3/5/6/7/8/9 and the `/tasks` and
`/tenants/:id` NO-ROUTE rows) and Anton's baseline (finding #3, `/tasks` has no `@Roles` and no
user scoping). Nothing here touches `src/` — Luke implements against this contract.

---

## 1. Context

Evidence gathered by reading the code, not by inference:

- **`GET /tasks/:id` has no tenant scope at all.** `TaskService.getTask(id)`
  (`src/tasks/task.service.ts:78-87`) is `findOne({ where: { id } })` — no `tenantId`. Every other
  method in the file (`addComment:284`, `updateTask:140`) correctly scopes by `tenantId`; this one
  method doesn't. This is a cross-**tenant** leak, one rung worse than Anton's finding #3
  (cross-**user**, same tenant) — a task id from tenant A reads on tenant B's token.
- **`/tasks` has no `@Roles` anywhere** (`task.controller.ts`, confirmed no decorator in the
  file) and **no ownership scoping in the service** — `PolicyGuard.canActivate`
  (`src/iam/guards/policy.guard.ts:39-48`) only checks roles when `@Roles()` is present, so this
  controller currently enforces nothing beyond "authenticated". `Task.assignedTo` is
  `NOT NULL` and is staff-to-staff (`entities/task.entity.ts:66-67`); the only per-record link to
  a client's own case is `Task.entityId` (nullable, `:76-77`), the same shape
  `DocumentAccessService.ownedEntityIds` already reads off `UniversalEntity.assignedTo`
  (`src/documents/document-access.service.ts:53-64`).
- **`TenantProvisioningService.deleteTenant`** (`src/iam/tenant-provisioning.service.ts:320-356`)
  **already exists and is wired to no route** — confirmed against Owen's `/api-json` check. It has
  a `permanent: true` branch that raw-deletes only `User` and `Tenant` rows in a transaction, and a
  soft-delete branch that sets `status = TenantStatus.DELETED` (`tenant.entity.ts:36`) and
  `deletedAt` (`:145`) — **both already exist as columns**; neither is filtered anywhere.
  `Tenant.slug` is `@Column({ unique: true })` (`:52`), so soft-delete without releasing it blocks
  re-signup under the same name forever. `setTenantStatus`'s own type signature
  (`:471`, `TenantStatus.ACTIVE | TenantStatus.SUSPENDED`) already refuses `DELETED`, confirming
  this path was never finished, not merely unwired.
- **`GET /health/capabilities` has no guard chain at all.** `@Roles(PlatformRole.PLATFORM_ADMIN)`
  sits on the handler (`src/health/health.controller.ts:52-56`), but neither the class nor the
  method carries `@UseGuards(AuthGuard('jwt'), PolicyGuard)` — the sibling route on the same
  controller (`check()`) is `@Public()`; this one is neither public nor guarded. `PolicyGuard` is
  what reads `@Roles()` (`policy.guard.ts:39-42`); with it absent from the chain, the decorator is
  inert and any authenticated caller (not just firm_admin) reaches it. `GlobalAuthGuard`
  (`src/core/auth/global-auth.guard.ts`, registered `APP_GUARD` in `app.module.ts:153`) still
  requires *a* valid JWT, so this is "any role", not "anyone" — but that is still wrong for a
  platform-wide configuration report.
- **`POST /tenant/settings` has two disagreeing schemas for the same body.**
  `tenant.controller.ts:48-72` hand-writes an `@ApiBody` with no top-level `required` array (what
  `/api-json` publishes); `VerticalConfigDto` (`tenant/dto/vertical-config.dto.ts:57-77`) has no
  `@IsOptional()` on `vertical`, `entityName` or `fields` (what `ValidationPipe` actually enforces).
  The two were never the same source of truth.
- **`GET /billing/plans` and `GET /billing/metrics` carry no `@Roles()` at all**
  (`billing.controller.ts:93-96, 175-179`) — today *any* authenticated role, including `client`,
  can read them for their own `tenantId`, and neither route reads an `X-Tenant-ID` header or takes
  any cross-tenant path, so an operator's own token (whose `tenantId` is the control-plane tenant,
  not a customer's) gets that tenant's — usually empty — plan/metric set. That is the honest
  explanation for the dashboard's "Insufficient Role" the request never actually reaches a 403
  from `PolicyGuard`; it is a frontend gate in front of a route with no operator path to gate.
- **`POST /tenants/check-slug`** (`tenant-provisioning.controller.ts:230-249`) is `@Public()`,
  calls `checkSlugAvailability` (`tenant-provisioning.service.ts:756-766`), and returns a bare
  `{available: boolean}` with no rate limit — confirmed against Anton's finding #2 (no durable
  limiter anywhere in `api/index.js`, production has zero brute-force protection on any route).
- **`GET /tenants/:id`** does not exist; only the list and `:id/{stats,entitlements,branding,
  connectors}` sub-resources do. `:id/stats` (`tenant-provisioning.controller.ts:282-325`) already
  contains the exact "own tenant vs platform_admin via `runAsGod`" shape a detail route needs.

---

## 2. Decisions

### D1 — `GET /tenants/:id`: mirror `:id/stats`'s own-tenant/god-mode split

**Route.** `GET /tenants/:id` → same controller as `:id/stats`
(`TenantProvisioningController`). **DTO:** none (path param only); response is the same shape
`listAllTenants()`'s rows already have, single-record.

**Roles / tenancy enforcement (service).** No `@Roles()` — every authenticated caller may reach
the handler, exactly like `:id/stats`. The service method (`getTenantById(id, callerTenantId,
isPlatformAdmin)`) returns the row unconditionally when `id === callerTenantId`; otherwise it
requires `isPlatformAdmin` and the controller wraps the call in `runAsGod`, identically to
`:id/stats` (`:303-324`). Enforcement lives in the service so a future second caller of
`getTenantById` cannot reach it unscoped by accident — the exact bug class `entity-access.ts`'s
header names as already having shipped three times.

**Errors.** 404 `MER-RES-0001` (existing `RESOURCE_NOT_FOUND`) — no such tenant. 403
`MER-AUTH-0008` (existing `AUTH_FORBIDDEN`) — non-admin reading another tenant, same as
`:id/stats`. No new codes.

**Audit.** `runAsGod`'s existing CRITICAL entry on the cross-tenant path only; an admin reading
their own tenant needs none, same as every other own-tenant read in this controller.

**Migration.** None — new route only, no schema change.

### D2 — `DELETE /tenants/:id`: soft-delete only; retire the unwired hard-purge branch

**Decision: soft-delete, not hard purge.** A regulated product cannot make a tenant's audit
trail, payment ledger and screening history disappear on an operator's say-so — `audit_logs` is
append-only by design (workspace `CLAUDE.md` §7.7) specifically so that a record of what happened
survives the actor who caused it. `TenantProvisioningService.deleteTenant`'s `permanent: true`
branch (`:326-343`) is also **incomplete** as a purge: it deletes `User` and `Tenant` rows only,
leaving every other tenant-scoped table (`crm.universal_entities`, `documents`, `payments`,
`tasks`, `audit_logs`, `communications`) orphaned under a `tenantId` that resolves to nothing.
**Delete that branch rather than fix it** — a correct hard purge is a retention-and-legal decision
(what a regulator requires be kept, for how long), not a code fix, and does not exist today.

**Route.** `DELETE /tenants/:id`, `platform_admin` only, `runAsGod`.
**DTO:** `{ confirmSlug: string }` body — must equal the tenant's current `slug`, the same
"type the name to confirm" pattern as every other irreversible-looking action in this product;
this is what makes it a deliberate act rather than a misclick on the God View table.

**Tenancy enforcement (service).** A new `TenantProvisioningService.softDeleteTenant(id,
confirmSlug)`: 404 if no such tenant; 400 if `confirmSlug !== tenant.slug`; 409 if already
`DELETED`. On success: `status = TenantStatus.DELETED`, `deletedAt = now()`, and **`slug` is
rewritten** to `${slug}--deleted--${id.slice(0,8)}` so the human-readable name is released for
reuse (the gap the existing dead branch left open — `slug` is `unique: true`). `listAllTenants`
and `getPlatformStats` (`:605-660`, `:573-600`) must add `status !== DELETED` to their query so a
deleted tenant stops appearing in the God View by default; a `?includeDeleted=true` flag on
`GET /tenants` covers audit/legal lookups without a second endpoint.

**Errors.** 404 `MER-RES-0001`. 400 `MER-VAL-0001` (confirmation mismatch). New:
`TENANT_ALREADY_DELETED = 'MER-TENANT-0008'` in `MeruErrorCode` (`src/common/types.ts`) —
additive, next number in the existing `MER-TENANT` family (`:67-80` currently ends at `-0007`).

**Audit.** `runAsGod` CRITICAL entry, `context: { tenantId, slug, releasedSlug }` — the same shape
as every other operator action here, nothing new to build.

**Migration.** None — `status`, `deletedAt` and the unique `slug` index all already exist.

**Teardown path for Owen's two `sweep-pilot-*` tenants:** `DELETE /tenants/:id` once shipped,
called against both with their own slugs as `confirmSlug`.

### D3 — `/tasks`: close the cross-tenant read, add `@Roles`, add client ownership scoping, add reopen

**Cross-tenant fix (highest priority in this decision).** `TaskService.getTask` must take
`tenantId` and filter on it, same as `updateTask`. This is a one-line change with no new surface
and should ship independently of the rest of D3 if there is any delay implementing it.

**Roles.** Add `@Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN,
PlatformRole.STAFF, PlatformRole.CLIENT)` — all four legitimately use `/tasks`; the point is
making the authorization surface explicit and auditable rather than implicit in "no decorator
means no check" (the exact ambiguity Anton's finding #3 names).

**Tenancy enforcement (service, not controller).** A new `TaskAccessService`, same shape as
`DocumentAccessService`: `scopeOf(actor)` — `god`/`tenant` see everything in the tenant;
`own` (client) sees a task only if `!task.internal && task.entityId` is in
`ownedEntityIds(tenantId, actor.id)` (reusing the entity-ownership query `DocumentAccessService`
already has — do not duplicate it, inject the same repository or extract a shared helper).
**New column:** `Task.internal: boolean, default: true`. Default `true` is deliberate and
fail-safe: no client sees any task's existence until staff explicitly clears the flag — because
today's bug exposes *every* task to *every* client, "default hidden" is strictly safer than
"default shown," and it mirrors `CrmCommentService`'s existing `internal` field
(`comment.service.ts:95`) for the identical staff-note-vs-client-visible problem.
**Migration:** `AddInternalToTasks` — `ALTER TABLE tasks ADD COLUMN internal boolean NOT NULL
DEFAULT true`.

**`PATCH /tasks/:id` status transitions, including reopen.** New DTO field on the existing
`UpdateTaskDto`/a new `UpdateTaskStatusDto { status: TaskStatus }`. Any forward or backward
transition is accepted except setting the same status twice (400) — this repo does not need a
second workflow engine when `src/workflow/` already owns state-machine authoring; `Task.status` is
a flat field, not a pack-driven workflow, and it is reopened by simply writing a different
`TaskStatus`, same mechanism `completeTask`/`cancelTask` already use. **A `client`-scope caller may
never write `status`** — same `OWN_SCOPE_READONLY_FIELDS` precedent as CRM
(`entity-access.ts:91-95`): "an applicant does not decide their own matter is closed" applies
identically to a task on their case.

**`DELETE /tasks/:id` does not exist, by decision.** `POST /tasks/:id/cancel` already exists
(`task.controller.ts`, calls `cancelTask`) and is the correct terminal state — consistent with
this product's audit-everything stance (workspace `CLAUDE.md` §7.7): a cancelled task stays in the
record and can be reopened via the new `PATCH status`; a deleted one could not.

**Errors.** 404 `MER-RES-0001` for a task outside the caller's scope (404, not 403 — same
"entity ids travel in checklists and links" reasoning as `entity-access.ts:60-67`). 400
`MER-VAL-0001` for a no-op or malformed status value. 403 `MER-AUTH-0008` for a client attempting
to write `status`.

**Audit.** Status transitions are not currently audited anywhere in this file; add an
`AuditService` entry at `INFO` (not `CRITICAL` — this is normal in-tenant casework, not a
cross-tenant reach) on every `PATCH .../status`, mirroring the severity choice `crm.service.ts`
already makes for ordinary entity writes (`:513-517`).

### D4 — `GET /health/capabilities`: platform-wide report stays platform-admin-only; fix the guard, not the audience

**Decision.** The report is inherently platform-wide (mail/AI/billing/storage/regulator
configuration for the whole deployment, not per-tenant), so there is no tenant-safe subset worth
carving out — the fix is that the existing intent (`platform_admin` only) was never wired, not
that the audience was wrong.

**Fix.** Add `@UseGuards(AuthGuard('jwt'), PolicyGuard)` to the `capabilities()` handler (or to
the `HealthController` class, with `check()` kept `@Public()` as it already is) in
`src/health/health.controller.ts`. No DTO — path/response unchanged.

**Errors.** 403 `MER-AUTH-0008` for a non-platform-admin, as the existing `@ApiResponse` already
documents — it was simply never enforced. No new codes.

**Audit.** None needed — this is a read of configuration state, not tenant data; no other
`platform_admin`-only *read* in this codebase (e.g. `GET /platform/stats`) is audited either,
and adding it here alone would be an inconsistent special case.

### D5 — `POST /tenant/settings`: one schema, not two

**Decision.** Delete the hand-written `@ApiBody({...})` block in `tenant.controller.ts:48-72` and
let `@nestjs/swagger` derive the schema from `VerticalConfigDto` directly — the pattern already
used by every other DTO-typed body in this repo. **Runtime behaviour does not change**:
`vertical`, `entityName` and `fields` stay required, matching Owen's own PASS row
(`fields: []` succeeds; a missing `fields` key correctly 400s). Only `/api-json` changes, to tell
the truth about what `ValidationPipe` already enforces.

**Errors.** 400 `MER-VAL-0001` (existing `VALIDATION_ERROR`) — unchanged. No new codes.

**Migration.** None.

### D6 — `/billing/plans` and `/billing/metrics`: per-tenant, with `X-Tenant-ID` for the operator

**Decision: per-tenant, not platform-wide aggregation.** Both routes already resolve entirely
from `req.user.tenantId` (`billing.controller.ts:96-102, 179-186`); building a platform-wide
rollup would be new aggregation code with no existing precedent, versus reusing the per-tenant
path the routes already have.

**Roles.** Add `@Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)` to both — today
*any* authenticated role, including `client`, can read a firm's billing plans and revenue metrics,
which this ADR closes as a byproduct of giving the operator a real path in.

**Tenancy enforcement (service).** Controller: if caller is `platform_admin`, read
`X-Tenant-ID` from the header; if absent, 400 (an operator has no "own" billing tenant worth
resolving to instead — the control-plane tenant's numbers are meaningless here). If caller is
`firm_admin`, `X-Tenant-ID` is ignored — forced to `req.user.tenantId`, exactly the payments
precedent (`payments.controller.ts:70-72`) of a forced value overriding rather than combining with
caller input. The resolved `tenantId` is what `BillingService.getPlans`/`getBillingMetrics`
already take — no service signature change. Cross-tenant reads (operator reading another firm's
revenue) go through `runAsGod`, same as `:id/stats`.

**Errors.** 400 `MER-VAL-0002` (existing `VALIDATION_REQUIRED_FIELD`) — platform_admin without
`X-Tenant-ID`. 403 `MER-AUTH-0008` — non-admin/non-firm-admin role, per the new `@Roles`.

**Audit.** `runAsGod` CRITICAL entry only for the cross-tenant (operator-reads-another-firm) path.

### D7 — Operator tenant-documents listing and job runner: the two dead dashboard registry entries

**`GET /platform/tenants/:id/documents`.** On `PlatformController`, `platform_admin`, `runAsGod`.
No DTO (path param + optional `?page`/`?limit`, same pagination contract as every other list).
**Metadata-only projection** — `id, name, fileType, originalFileName, fileSize, mimeType, status,
linkedEntityType, linkedEntityId, versionNumber, uploadedById, createdAt` from
`documents/entities/document.entity.ts:41-138` — explicitly **excluding** `s3Url`, `rbac` and
`aiAnalysis` (the last may hold extracted PII text), so this route can never become a bytes path
by a later careless `select: '*'`. **Enforcement (service):** a new
`DocumentAccessService.listMetadataForTenant(tenantId)` — a distinct method, not a relaxed
`applyScope`, so this operator path cannot be reached by accidentally passing a non-god actor into
the existing client-facing method. 404 `MER-TENANT-0001` (existing `TENANT_NOT_FOUND`) if the
tenant id doesn't exist. Audit: `runAsGod` CRITICAL (an operator reading another firm's document
inventory, even as metadata, is exactly the class of access that constant is for).

**`POST /platform/jobs/:job/run`.** On `PlatformController`, `platform_admin`, `runAsGod` —
**this is the human-operator path, replacing `CRON_SECRET`, not adding to it.** It delegates to
the same `JobRunService` the existing `/jobs/:job` (machine, `CronSecretGuard`) already calls
(`jobs.controller.ts:283-295`), so there is exactly one job implementation with two front doors:
a secret for the scheduler, a role for a human. **"Same secret discipline as `CronSecretGuard`"
means the same fail-closed shape, applied to job-name validation**: an unrecognised `:job` (not a
key of `JOB_CADENCE_MINUTES`) is a 404, never a silent no-op — `CronSecretGuard` fails closed on
an absent secret; this route fails closed on an absent job. **DTO:** none (path param only).
Errors: 404 `MER-RES-0001` unknown job. Audit: `runAsGod` CRITICAL, `context: { job }` — a manual
trigger of a scheduled process is exactly the kind of action this audit tier exists to record.

### D8 — `POST /tenants/check-slug`: stays public; rate-limit it, don't gate it behind auth

**Decision: keep public, add a rate limit — do not require authentication.** Every comparable
self-serve signup flow (this one included, at `POST /tenants/signup`) needs an unauthenticated
"is this name taken" check; requiring auth here would break the exact flow this route exists for.
The real gap Owen-1 names is volume, not existence: nothing stops an unauthenticated caller from
enumerating the entire slug space at whatever rate the client can send requests, because Anton's
finding #2 already established there is **no durable rate limiter anywhere** in `api/index.js`.

**This decision does not re-solve Anton's finding #2** — it rides on whatever durable limiter
that ADR/fix introduces (Upstash + `@upstash/ratelimit`, per Anton's own recommendation), and adds
one requirement on top: **`check-slug` gets a tighter per-IP ceiling than the general
unauthenticated-route limit**, because unlike a login attempt it costs an attacker nothing to
retry and produces no lockout signal. Response shape (`{available: boolean}`) is unchanged — a
"neutral" non-committal response would break the legitimate case (a real prospective customer
needs a true/false answer).

**Errors.** 429 `MER-RATE-0001` (existing `RATE_LIMIT_EXCEEDED`) once the shared limiter lands.
No new codes; no change to this route's own DTO/handler beyond the limiter middleware wrapping it.

---

## 3. Options rejected

| # | Option | Why rejected |
|---|---|---|
| D2 | Fix the existing `permanent: true` hard-delete branch instead of retiring it | It deletes 2 of roughly a dozen tenant-scoped tables; making it correct is a retention/legal-basis decision (what must survive, for how long, for which regulator) that does not exist yet, not a code fix |
| D2 | Add a `DELETE` that hard-purges immediately, gated only by a confirmation token | Same objection — a token proves intent, not that purging `audit_logs` is legal for this tenant's jurisdiction |
| D3 | Scope client task access via `Task.assignedTo` directly (tasks assigned to the client) | `assignedTo` is `NOT NULL` and staff-to-staff by construction (`assignedBy`/`assignedTo` are both users who do casework); a client is never the assignee today, so this would scope every client to zero tasks rather than their case's tasks |
| D3 | A full pack-driven state machine for `Task.status` | `src/workflow/` already owns state machines for pack-authored processes; `Task.status` is a flat, non-pack field and does not need a second engine |
| D4 | Carve out a tenant-safe subset of the capabilities report for `firm_admin` | Every field in the report is platform-wide (global mail/AI/storage config), not per-tenant — there is no subset that means anything to a single tenant |
| D6 | Build a platform-wide billing aggregation for the operator | No existing rollup code to build on; per-tenant + `X-Tenant-ID` reuses the routes' entire existing implementation |
| D7 | Give the operator the actual document bytes, not just metadata | Directly contradicts workspace `CLAUDE.md` §5.1b's "short-TTL server-signed URLs only" storage model; an operator inventory has no legitimate need to open a client's passport scan |
| D8 | Require authentication on `check-slug` | Breaks the unauthenticated self-serve signup flow this route exists to support |
| D8 | Return a deliberately vague/neutral response (`{ok: true}` always) | Breaks the legitimate use case — a real prospective customer needs to know if the name is free |

---

## 4. Consequences

1. **D2 and D3 both add columns/rewrite a unique field on `tenants`/`tasks`** — small, additive,
   default-safe migrations, but they are still schema changes on tables everything else joins
   against; run `npm run rls:verify` after each, not just the unit suite.
2. **D3's `internal` default (`true`) silently hides every existing task from every client**,
   including any task a firm may have been relying on a client seeing by the current (buggy)
   accident of no scoping at all. This is the correct direction to fail, but it is a visible
   behaviour change a firm_admin will notice on their first login after deploy — say so in the
   frontend changelog, not just here.
3. **D6 and D7 both add real, audited operator reach into a specific tenant's financial and
   document data** — the same class of power ADR 0006 already named for the invite-link route:
   more capability for a role that already has broad reach, made visible in a response body for
   the first time rather than being newly granted.
4. **D8 does not remove the enumeration property, it only slows it down.** A determined attacker
   with a botnet still enumerates the slug space; the fix here defends against a casual scraper,
   not a resourced one. Full closure would need CAPTCHA or an account-linked check, both of which
   damage the self-serve conversion funnel this route exists for — not worth it until abuse is
   observed.

---

## 5. What would make these decisions wrong later

| Trigger | Which decision it invalidates | What to do |
|---|---|---|
| A regulator requires provable, permanent erasure of a tenant's data within a fixed window (GDPR-style "right to erasure" reaching a jurisdiction Meru serves) | D2's "soft-delete only" | Design the real hard-purge as its own ADR, enumerating every tenant-scoped table and what a compliant purge does to `audit_logs` specifically — do not extend the existing broken `permanent: true` branch |
| A vertical pack wants client-visible tasks to be the default, not the exception (e.g., a client-facing checklist genuinely is a `Task`, not a `documentTypes[]` entry) | D3's `internal: true` default | Revisit per-vertical: a pack-level default for `internal` on tasks created via a workflow template is a Layer-4 decision, not a Layer-1 one — do not flip the core default |
| Anton's finding #2 (no durable rate limiter) ships a general solution that already covers unauthenticated routes at the edge (Vercel Firewall / WAF rule) | D8's "add a rate limit here" | Confirm `check-slug` is covered by the general rule before adding a second, redundant limiter in application code |
| The operator dashboard needs a genuine platform-wide revenue rollup (not per-tenant) for board reporting | D6's "per-tenant only" | That is new aggregation work and a new route (`GET /platform/billing/summary` or similar) — do not overload `/billing/metrics` with a mode switch |

---

## 6. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| D1 `GET /tenants/:id` | Remove the route and `getTenantById` | None — read-only |
| D2 `DELETE /tenants/:id`, `softDeleteTenant`, slug-release, list/stats filtering, `TENANT_ALREADY_DELETED` | Remove the route; revert `permanent: true` branch removal only if nothing depended on it (nothing does — confirmed unwired) | Any tenant already soft-deleted keeps its rewritten slug and `deletedAt` — correct, matches the same "the audit trail of what happened is not itself reversible" stance as everywhere else in this product |
| D3 `getTask` tenant fix | Revert the one-line change | None |
| D3 `internal` column, `TaskAccessService`, `@Roles`, `PATCH .../status` | Drop the migration (`ALTER TABLE tasks DROP COLUMN internal`); remove the route and decorator | None if reverted before any task is marked `internal: false` — after that, reverting loses which tasks a firm had deliberately exposed to clients, so confirm with the firm before reverting once live |
| D4 guard on `/health/capabilities` | Remove the `@UseGuards` | None |
| D5 `@ApiBody` removal | Revert the deletion | None — Swagger-only |
| D6 `@Roles`, `X-Tenant-ID` handling | Remove both; routes return to "any authenticated role, own tenant only" | None |
| D7 both routes | Remove; `DocumentAccessService.listMetadataForTenant` is additive and used nowhere else | None |
| D8 rate limit | Remove the middleware for this route | None |

**Rollback verification:** for D2 specifically, confirm `listAllTenants`/`getPlatformStats`'s new
`status !== DELETED` filter is the only change to those two methods before reverting — a rollback
that also reverts the filter would make previously-deleted tenants reappear in the God View list,
which is a worse regression than the one being rolled back.
