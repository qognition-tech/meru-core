# ADR-0001 — Practice roles as additive vertical tags on `User`

**Status:** Accepted. Executable contract for implementation — Luke implements against this
without a second design decision.

**Date:** 2026-09-03

**Owner:** Kyle (architect). Implementation: Luke (backend-dev). Review/gate: Owen (quality).

---

## 1. The decision, in one sentence

A practice role (`agent`, `paralegal`, `migration_agent`, `mlro`, …) is an **additive string tag**
on `User`, sourced from and validated against the tenant's resolved vertical pack `roles[].key`;
`PlatformRole` stays exactly four values and keeps doing portal routing and coarse `@Roles` gating.
The two vocabularies are never merged into one enum.

---

## 2. Context — what is already true, not re-derived here

- `WorkflowEngineService.checkPermissions` (`src/workflow/workflow.service.ts:706`) read only
  `permissions.users`. `PackWorkflowService.materialise` (`src/workflow/services/pack-workflow.service.ts:202`)
  writes `permissions: step.assignedRole ? { roles: [step.assignedRole] } : {}` — never `users` — and
  the AU pack (`packages/config-packs/countries/au-immigration.json`) sets `assignedRole` on all 14
  steps of `wf_visa_matter`. "Materialise all" is a live, reachable button.
- **Patched in commit `4f285d1`.** `checkPermissions` now has four branches: no constraint → allow;
  named in `users` → allow; actor holds a required, evaluable `PlatformRole` → allow; a requirement
  naming **no evaluable `PlatformRole`** → **allow, and warn** (deferral to the controller's
  `@Roles(STAFF, FIRM_ADMIN)`). 9 regression tests in `src/workflow/workflow-permissions.spec.ts`
  pin this, and the file's own doc comment already states the deferral branch **must be deleted**
  when the practice-role model lands — §5 below is that deletion, precisely specified.
- `IamService.updateUser` (`src/iam/iam.service.ts:899`) does `user.roles = [updates.role]` — a
  full-array replace. `User.roles` (`src/iam/entities/user.entity.ts`) is a single `simple-array`
  column (physically `text`, comma-joined) carrying `PlatformRole` values only. A directory edit
  through this path must never touch the new carrier — see §3.
- Pack vocabulary vs. product doc vocabulary disagree. `packages/config-packs/verticals/immigration.json`
  `roles[]` = `firm_admin, migration_agent, case_coordinator, client_portal`.
  `meru-core-fe/immistack/CLAUDE.md` §2's capability matrix names `platform_admin, firm_admin,
  manager, agent, paralegal, client, partner`. Ruled in §6.
- `TenancyService.runAsGod` (`src/core/tenancy/tenancy.service.ts:44`) writes its `CRITICAL` audit
  entry with an explicit `tenantId: targetTenantId` — that entry is correctly attributed. The risk is
  downstream: `runAsGod` → `TenantContext.runAsGod` (`src/core/tenancy/tenant-context.ts:88`) adds
  `bypass: {kind:'god', …}` to the ALS store but **does not update `tenantId`** in that store. RLS
  binding (`applyRlsToDataSource`, `src/core/tenancy/rls.datasource.ts:47`) sets
  `app.current_tenant_id` from `store.tenantId`, so for the duration of a god-mode callback that GUC
  still reflects the **operator's own tenant** (or empty), not the target. `bypass_rls='on'` makes
  this harmless for RLS itself, but anything inside the callback that derives "which tenant" from
  ambient context rather than an explicit parameter will silently resolve against the wrong tenant.
  `VerticalPackService.forVertical()` (`src/tenant/services/vertical-pack.service.ts:94`) is exactly
  such a function — it calls `TenantContext.getTenantId()` to find a pin. **Do not call
  `forVertical` unqualified inside a `runAsGod` callback.** See §5.

---

## 3. The carrier

**New column: `User.verticalRoles: string[]`, a native Postgres array, not a key under
`attributes`.**

```ts
// src/iam/entities/user.entity.ts
@Column({ type: 'text', array: true, default: '{}' })
verticalRoles: string[];
```

**Why a dedicated column, not `attributes.practiceRoles`:**

- `attributes` (`jsonb`) is already a free-form bag (`department` lives there today). A second,
  differently-shaped key in the same bag invites the same accidental-overwrite pattern that already
  exists in `IamService.updateUser` — `user.attributes = { ...user.attributes, department: … }` is
  written correctly (spread-preserving), but every future editor of `attributes` has to remember to
  spread. A dedicated column cannot be silently dropped by an unrelated `attributes` write.
- A native `text[]` (not `simple-array`) is queryable with `&&`/`@>` for the census query in §9,
  without parsing a comma-joined string or walking JSON.
- It sits next to `roles` structurally — same table, same row, same audit trail — which keeps
  "what can this user do" answerable from one row instead of two shapes.

**Migration.** New file, next timestamp after whatever is `HEAD` at implementation time (the AU
pack's own agent is actively landing migrations in `src/workflow/`; do not hand-pick a timestamp
that might collide — generate normally). Shape:

```sql
ALTER TABLE "users" ADD COLUMN "verticalRoles" text[] NOT NULL DEFAULT '{}';
```

- **Nullability:** `NOT NULL DEFAULT '{}'` — an absent tag list must read as "no practice roles",
  never `NULL`, so every call site can do `.includes()`/`.some()` without a null check.
- **Index:** none at launch. The hot-path read is a by-id row fetch (already PK-indexed); the only
  array-scan consumer is the pre-launch census query in §9, run a handful of times, not per-request.
  Add a `GIN` index later only if a recurring "which users hold role X" report needs one — do not
  speculatively add it now.
- **RLS:** none needed beyond what `users` already carries — this is a plain column on an
  already-`ENABLE`+`FORCE` RLS table.

**Do not put practice tags in `User.roles`.** Even though `checkPermissions`'s `userRoles` parameter
would technically match a tag concatenated into that array (string equality doesn't care which
column it came from), `roles` is single-purpose today (`resolvePrimaryRole` walks it for portal
routing) and `IamService.updateUser` replaces it wholesale on any role edit — exactly the landmine
this ADR must not build on top of.

---

## 4. Validation

**A tag is valid only if it is a `key` in the tenant's resolved vertical pack `roles[]`.**

- **Resolver:** `VerticalPackService.forVertical(vertical)` →
  `VerticalPackService.list<{key:string; label:string}>(vertical, 'roles')`. Both already exist
  (`src/tenant/services/vertical-pack.service.ts:94,163`) and already return `[]` (never throw) when
  the vertical has no pack — the correct behaviour to inherit: a tenant with no pack can grant no
  practice roles, and the grant route must say so rather than 500.
- **Where it runs:** service-layer only, not the DTO. The DTO (`class-validator`) can enforce
  "array of non-empty strings, max length N" — it cannot know the tenant's pack vocabulary at
  decoration time. Real validation is in `IamService` (new method, §5), against a freshly resolved
  pack, on every grant. Do not cache the pack roles list across requests without an invalidation
  path — a pack version bump must be able to add/rename roles same-day.
- **The `firm_admin` overlap.** The immigration pack's `roles[]` includes a `firm_admin` entry whose
  `key` string collides with `PlatformRole.FIRM_ADMIN`. This is harmless and does not need special
  casing: `checkPermissions`'s rule 3 (§5) already matches `firm_admin` via `PlatformRole`, so tagging
  a user with `verticalRoles: ['firm_admin']` would be redundant, not wrong, and validation should
  simply allow it like any other pack role key.
- **Rejection shape:** 400, `MER-VAL-0xxx` (existing error family — pick the next free code in that
  family; grep `src/common` for the registry before assigning one), listing which tag(s) are not in
  the resolved pack and the pack `code@version` checked, mirroring the existing "name the pack and
  version" convention in `sectionWithPack`.

---

## 5. `checkPermissions` after the change

Delete the deferral branch. Four branches become three:

```ts
private checkPermissions(
  permissions: { roles?: string[]; users?: string[] },
  userId: string,
  userRoles: string[] = [],   // PlatformRole[] ∪ User.verticalRoles, concatenated by the caller
): boolean {
  if (!permissions.roles?.length && !permissions.users?.length) return true;
  if (permissions.users?.includes(userId)) return true;

  const required = permissions.roles ?? [];
  if (required.length && required.some((r) => userRoles.includes(r))) return true;

  return false;
}
```

- **The evaluability distinction (`platformRoles.includes(r)`) goes away entirely.** There is no
  more "unevaluable role" once `verticalRoles` exists — every string in a pack's `assignedRole`
  either matches a tag the user holds or it does not. A denial is now always a real denial, which is
  the whole point of §2's "rule 4 must be deleted."
- **The caller assembles `userRoles`.** `WorkflowEngineService.executeTransition` (line ~445) and
  `workflow.controller.ts:257` currently pass `req.user.roles ?? []`. Change both call sites to
  `[...(req.user.roles ?? []), ...(req.user.verticalRoles ?? [])]`.
- **`req.user` is a JWT claim, not a live row.** `JwtStrategy.validate` (`src/iam/strategies/jwt.strategy.ts`)
  returns the decoded payload; it does not re-read the user from the database per request. So
  `verticalRoles` must be added to the token, exactly parallel to how `roles` already works:
  - `JwtPayload` (`src/common/types.ts:130`) and `UserPayload` (`:149`): add `verticalRoles: string[]`.
  - `IamService.issueSession` (`:1144`, used by login/register/refresh): sign
    `verticalRoles: user.verticalRoles ?? []` alongside `roles`.
  - `IamService.refreshTokens` (`:~899` region): the `payload: UserPayload` it builds from
    `session.user` already re-reads the row fresh — add `verticalRoles: user.verticalRoles ?? []`
    there too, so a grant becomes effective on the caller's next silent refresh, not just full
    re-login. This mirrors `roles`' existing staleness window exactly (bounded by the 1-hour access
    token TTL, `issueSession`'s `expires_in: 3600`) — no new behaviour class, no regression.
  - `IamService.impersonate` (`:~1195`): add `verticalRoles: target.verticalRoles ?? []` to the
    minted token, for the same reason `roles` is read from `target` there.
  - `JwtStrategy.validate`: return `verticalRoles: payload.verticalRoles ?? []` onto `req.user`.
- **Remove the now-dead `PlatformRole` import check** (`Object.values(PlatformRole) as string[]`)
  from `checkPermissions` along with the branch — do not leave it as unreachable code.
- **Update `workflow-permissions.spec.ts` in the same commit.** The test titled *"does NOT lock out
  staff when the required role is a pack role with no carrier on User"* and the one titled *"warns
  when it defers"* both assert the deleted behaviour — replace them with the mirror-image assertions:
  an actor without the matching `verticalRoles` tag is **refused**, and no warning is logged (there
  is nothing left to warn about — an unmatched role is not an authoring gap, it is a normal denial).
  Keep the regression test that already asserts a real `PlatformRole` denial stays a denial; keep the
  AU-pack-coverage test but flip its expectation to `false` for an actor lacking the tag and add a
  parallel case asserting `true` when the actor's `userRoles` includes the pack key directly (i.e.
  simulate a tagged actor, not just a `PlatformRole`-holding one).

---

## 6. Ruling the naming — pack renames to match the product doc

**The pack moves. The doc does not.**

Reasoning: `meru-core-fe/immistack/CLAUDE.md` §2 encodes a fact independent of this codebase — under
the Migration Agents Registration Authority Code of Conduct, only a Registered Migration Agent
("RMA") may sign off advice, lodgement or ART advice, and the doc's `agent`/`paralegal` split exists
*because of that external constraint*, not because someone picked a name. The pack's
`migration_agent`/`case_coordinator` were named at pack-authoring time with no reference to the
finished capability matrix, and the pack is also missing two roles the doc requires entitlement
distinctions for (`manager`, `partner`) entirely. Renaming a pack is a JSON edit and a version bump;
rewriting the doc would mean re-deriving which capabilities map to a regulatory fact, badly.

Concretely, in `packages/config-packs/verticals/immigration.json` (pack authoring — a separate
commit, out of this ADR's write scope, and **not performed here**):

| Pack key today | Renames to | Why |
|---|---|---|
| `migration_agent` | `agent` | Matches the doc's RMA-sign-off role exactly. |
| `case_coordinator` | `paralegal` | Matches the doc; "coordinator" implied no ceiling on authority, "paralegal" correctly implies "prepares, cannot sign off." |
| `client_portal` | `client` | Collapses onto `PlatformRole.CLIENT` exactly (`'client'`), so client-facing steps resolve via `checkPermissions` rule 3 with **no `verticalRoles` tag needed on any client user** — see §7. |
| `firm_admin` | *(unchanged)* | Already matches `PlatformRole.FIRM_ADMIN`. |
| *(absent)* | add `manager` | The doc's capability matrix gives `manager` a distinct row (release a commercial hold, invite staff below own level) that neither `firm_admin` nor `agent` covers. |
| *(absent)* | add `partner` | The doc's affiliate-dashboard row has no pack role to attach to today. |

**This rename requires a version bump** (`immigration.json` `version` field) — the loader only
upgrades on strictly-greater version (CLAUDE.md §4.2 rule 4) — and **does not retroactively rewrite
already-materialised `workflow_transitions`**. Materialisation is operator-triggered
(CLAUDE.md §16, "Pack `workflows[]`" row): a tenant that already clicked "Materialise all" under the
old vocabulary keeps `permissions.roles: ['migration_agent']` on its live transitions until it
re-materialises. **§8's backfill step must be keyed to whichever vocabulary is actually live in each
tenant's materialised transitions at verification time — not to the pack's current `roles[]`.** This
is why §9's census query reads `workflow_transitions.permissions`, not the pack file.

**GRC is out of scope for this rename.** `grc.json` roles[] (`compliance_officer, kyc_analyst,
relationship_manager, mlro`) has no competing product doc in this checkout to reconcile against —
`meru-core-fe/governancex/` carries no `CLAUDE.md` today. `[NEEDS DATA: a GovernanceX product doc
naming roles, if one exists elsewhere]`. Until one surfaces, the GRC pack vocabulary stands as
written; do not rename it by analogy to ImmiStack.

---

## 7. `signedOffBy`

**Carrier: extend the existing `permissions` jsonb on `WorkflowTransition`, and the existing
`history[]` jsonb on `WorkflowInstance`. Neither needs a migration — both columns are already
schemaless jsonb; this is two TypeScript type extensions plus a Zod/materialisation change.**

Do **not** reuse `permissions.requireApproval` / `permissions.approvers`
(`src/workflow/entities/workflow-transition.entity.ts:81-83`). Those two fields are declared on the
entity and DTO and **read by nobody** — the same "validates, stores, read by nobody" shape CLAUDE.md
§4.1 already warns about for `rules[]`. They model a different thing (approval by named individuals)
from a regulatory sign-off by whoever holds a specific practice role, and conflating the two would
leave both half-implemented. This ADR does not wire `requireApproval`/`approvers` — that is a
separate, still-open gap; say so if anyone asks, don't fix it here.

**Pack schema** (`packages/config-packs/_schema/pack.schema.ts`, `WorkflowStepSchema`, line ~37 —
pack-authoring/schema change, not performed here, out of write scope):

```ts
const WorkflowStepSchema = z.object({
  // ...existing fields...
  requiresSignOff: z.boolean().default(false),
  /**
   * The practice-role key (from this pack's roles[]) permitted to satisfy the
   * sign-off. Defaults to the step's own assignedRole when omitted. A step with
   * requiresSignOff: true and no resolvable role (neither signOffRole nor
   * assignedRole) must fail pack validation, not materialise silently.
   */
  signOffRole: z.string().optional(),
});
```

This is a **two-part change** (Zod schema + `npm run packs:schema` regen), not the three-part rule in
CLAUDE.md §4.2 — `workflows[]` is already one of the loader's persisted top-level arrays, so no
change to the loader's key list is needed for a new field nested inside it.

**Materialisation** (`PackWorkflowService.materialise`, `src/workflow/services/pack-workflow.service.ts:202`):

```ts
permissions: {
  roles: step.assignedRole ? [step.assignedRole] : [],
  signOffRole: step.requiresSignOff ? (step.signOffRole ?? step.assignedRole ?? null) : null,
},
```

**Entity type extension** (`WorkflowTransition.permissions`):

```ts
permissions: {
  roles: string[];
  users: string[];
  requireApproval: boolean;   // unchanged, still unwired — see above
  approvers: string[];        // unchanged, still unwired
  signOffRole?: string | null;
};
```

**Enforcement, in `WorkflowEngineService.executeTransition`**, immediately after the `checkPermissions`
gate (line ~450), before the payment-arrears check:

```ts
if (transition.permissions.signOffRole) {
  const signedOff = request.userRoles?.includes(transition.permissions.signOffRole);
  if (!signedOff) {
    throw new BadRequestException(
      `Transition requires sign-off by '${transition.permissions.signOffRole}'; ` +
        `actor does not hold that role.`,
    );
  }
}
```

**History entry** (`WorkflowInstance.history[]` type, `src/workflow/entities/workflow-instance.entity.ts:70`,
and the push site at `workflow.service.ts:497`):

```ts
history: Array<{
  timestamp: Date;
  fromState: string;
  toState: string;
  transitionId: string;
  triggeredBy: string;
  context: Record<string, any>;
  signedOffBy: string | null;   // new — the actor's userId, only when this
                                 // transition's signOffRole gate was satisfied.
                                 // Never `updatedBy`; a record of *whose sign-off*
                                 // satisfied the Code of Conduct, distinct from
                                 // who merely triggered the state change.
}>;
```

Populate `signedOffBy: transition.permissions.signOffRole ? request.userId : null` at the same push
site. **Which stages require sign-off is declared in the pack** (`requiresSignOff` on the relevant
steps — e.g. AU's `advice_given` and `application_lodged` steps), never hardcoded in `src/`, per the
80/20 rule. Authoring which specific AU steps get `requiresSignOff: true` is pack-authoring work, not
performed here.

---

## 8. The grant path

**Route:** `PATCH /iam/users/:id/practice-roles`, new handler in `UsersController`
(`src/iam/users.controller.ts`), guarded `@Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)` —
the same pair already guarding `PATCH /iam/users/:id`. **Do not fold this into the existing
`PATCH /iam/users/:id` / `UpdateUserDto`.** That route's `role` field is a single `@IsEnum(PlatformRole)`
value with static validation; `verticalRoles` needs dynamic, per-tenant pack validation (§4) that a
`class-validator` decorator cannot express, and keeping it a separate route makes the audit entry
(below) unambiguous about what changed.

**DTO** (new, `src/iam/dto/grant-practice-roles.dto.ts`):

```ts
export class GrantPracticeRolesDto {
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  verticalRoles: string[];
}
```

Full replace semantics (like `role` in `UpdateUserDto`), not merge — this is a dedicated,
single-purpose array, so "send the complete set" is unambiguous and matches the one existing
full-replace convention (`POST /crm/entities` per CLAUDE.md §5.5) rather than inventing a
merge-patch for a 10-element array.

**Service:** `IamService.grantPracticeRoles(tenantId: string, actor: {id: string; email: string},
userId: string, dto: GrantPracticeRolesDto): Promise<DirectoryUser>`

1. Load `user` by `{id: userId, tenantId}` — 404 if absent (existing `updateUser` pattern).
2. Load `tenant` (already available via existing tenant lookups in `IamService`) for `tenant.vertical`.
3. `const validRoles = await this.verticalPackService.list<{key:string}>(tenant.vertical, 'roles')`.
   `IamModule` must add `VerticalPackModule` to its `imports` — `TenantModule` (already imported by
   `IamModule`) does **not** re-export `VerticalPackService` (see its `exports` array,
   `src/tenant/tenant.module.ts:61-72`); it must be imported directly, same as `WorkflowModule`
   already does.
4. Validate every `dto.verticalRoles` entry is in `validRoles.map(r => r.key)` — 400 `MER-VAL-0xxx`
   naming the invalid tag(s) and `tenant.vertical`'s pack code/version if none are valid.
5. `user.verticalRoles = dto.verticalRoles; await this.userRepo.save(user)`.
6. **Write an explicit audit entry.** `IamService` does not inject `AuditService` today — grep
   confirms zero audit calls anywhere in `iam.service.ts`, including the existing `updateUser`
   `PlatformRole` change. This is the first audited mutation in that service; inject `AuditService`
   (already exported by `AuditModule`, already imported by `IamModule`). Call
   `auditService.logUpdate(tenantId, actor.id, 'user', userId, {verticalRoles: <before>},
   {verticalRoles: dto.verticalRoles})`, `AuditSeverity.INFO` (this is a same-tenant admin action,
   not cross-tenant — `CRITICAL` is reserved for god-mode per `runAsGod`'s existing convention).

**Cross-tenant grant (operator God UI, `meru-dashboard`).** A `platform_admin` editing a user in a
tenant that is not their own must go through `TenancyService.runAsGod(operatorId, targetTenantId,
reason, fn)`. Inside `fn`, **do not call `verticalPackService.forVertical(vertical)` unqualified** —
per §2, `runAsGod` does not update the ALS store's `tenantId`, only `bypass`, so the ambient pin
resolution would silently check the *operator's own* tenant's pin, not the target's. Instead, mirror
the pattern `IamService.refreshTokens()` already uses at line ~884
(`TenantContext.setTenantId(user.tenantId)` before tenant-bound work): explicitly bind
`TenantContext.setTenantId(targetTenantId)` inside the `runAsGod` callback before calling
`forVertical`, so pin resolution is scoped to the tenant actually being edited. Write the audit entry
with `tenantId: targetTenantId` and `AuditSeverity.CRITICAL` to match the existing god-mode
convention (the grant itself, not just the god-mode entry the wrapper already writes).

**Who may grant, restated:** `firm_admin` may tag any user in their own tenant; `platform_admin` may
tag any user in any tenant (via the god-mode path above). No other role may call this route. A tagged
user cannot self-grant — there is no route through which a caller supplies their own `id`.

---

## 9. Backfill and rollout order

**Rule: enforcement (§5's deletion of the deferral branch) must not deploy until §9's census query
returns zero rows for every tenant that has at least one materialised role-bearing transition.**
Deploying it earlier locks out every actor on every gated transition in every tenant that has
materialised a pack workflow, because a required-but-untagged role now denies instead of warning.

1. **Ship the carrier + validation + grant route** (§3, §4, §8). Additive; `checkPermissions` is
   untouched. No behaviour change for any existing user. Deployable independently and immediately.
2. **Run the census query (below) against production**, per tenant, to find every user who would be
   denied if enforcement shipped today.
3. **Backfill.** For each locked-out user, grant (§8) the tag(s) matching their **currently
   materialised** transition requirements — i.e. whatever vocabulary that tenant's live
   `workflow_transitions.permissions.roles` actually contains right now, not the pack's current
   `roles[]` if the tenant hasn't re-materialised since a rename (§6). Re-run the census query until
   it is empty for that tenant.
4. **Re-run the census query for every tenant with materialised workflows, not just the ones already
   checked** — a tenant materialising for the first time between step 2 and deploy would otherwise be
   missed.
5. **Only once the census query is empty across all tenants**, ship §5 (delete the deferral branch,
   thread `verticalRoles` through the JWT and both call sites, update
   `workflow-permissions.spec.ts`). This is one code deploy, global — there is no per-tenant flag.
   `FeatureFlagService` (`src/tenant/services/feature-flag.service.ts`) exists and is tenant-scoped,
   but it is CRUD-only today (no `isEnabled` read helper, consumed by nothing as a runtime gate) — 
   wiring it in for a one-time cutover is more machinery than the risk warrants when the census query
   can be driven to zero first and the flip verified, matching how the entitlements rollout in
   CLAUDE.md §5.5b was staged (verify against a real tenant, then ship, not a flag).
6. **Verify against a real tenant before the flip**, per the standing rule: pick one immigration
   tenant that has materialised `wf_visa_matter`, confirm every active staff user on it passes the
   census query, deploy, then immediately exercise one gated transition as a tagged user (should
   succeed) and confirm a deliberately-untagged test user is refused (should 400, not 200) — the
   `smoke:sweep` contract sweep cannot see this class of defect (CLAUDE.md §8.2, "passes on a
   well-formed 503... cannot see a wrong answer").
7. **§6's pack rename is independent and may ship before or after enforcement**, but if it ships
   first, step 3's backfill must target the *new* vocabulary for any tenant that re-materialises
   before enforcement flips, and the old vocabulary for any tenant that does not. Track this per
   tenant; do not assume every tenant is on the same pack version.

**Rollback, at each step:**

- **Step 1 (carrier/validation/route):** additive-only; rollback is deleting the column
  (`ALTER TABLE users DROP COLUMN "verticalRoles"`) and the route. No data loss beyond the tags
  themselves, since nothing yet reads `verticalRoles` for enforcement.
- **Step 3 (backfill):** each grant is audited (§8) with before/after state — a bad backfill is
  reversible by replaying the audit log's `beforeState` through the same grant route.
- **Step 5 (enforcement flip):** rollback is redeploying the prior commit, which restores the
  deferral branch verbatim (it is a pure code revert — no data migration accompanies this step, so
  there is nothing to reverse at the database level). This is the reason step 5 is gated so hard on
  step 2–4: a bad flip is cheap to undo in code but expensive in the minutes it is live, since every
  denied transition is a blocked matter until the revert deploys.
- **Step 7 (pack rename):** rollback is reverting the pack JSON and its version bump; per CLAUDE.md
  §4.2 rule 4, the loader only upgrades on strictly-greater version, so a reverted-but-still-higher
  version number will not silently re-apply — bump forward again with a corrected file rather than
  trying to reuse the old version number.

---

## 10. §7.2 — GovernanceX

**GRC gets the identical mechanism — same column, same `checkPermissions`, same grant route — with
its own pack vocabulary. Nothing vertical-specific enters `src/`.**

- The carrier (`User.verticalRoles`), the validator (`VerticalPackService.list(vertical, 'roles')`),
  `checkPermissions`, the grant route and its DTO are all vertical-neutral by construction: none of
  them reference `immigration`, `agent`, `paralegal`, `migration_agent` or any ImmiStack string. The
  only immigration-specific artefact in this whole ADR is §6's rename table, which touches
  `packages/config-packs/verticals/immigration.json` — a pack file, not `src/`.
- `grc.json` roles[] (`compliance_officer, kyc_analyst, relationship_manager, mlro`) validates
  through the same `VerticalPackService.list('grc', 'roles')` call with zero code changes.
- **`signedOffBy` (§7) needs its own GRC authoring**, separately from ImmiStack's: if GRC has an
  equivalent regulatory-sign-off concept (an `mlro` filing a SAR reads as the natural candidate, given
  `mlro` = Money Laundering Reporting Officer, a named statutory role), that is a `requiresSignOff` +
  `signOffRole: 'mlro'` declaration on the relevant GRC pack workflow step(s) — pack authoring, not
  performed here, and **not assumed** — `[NEEDS DATA: does GRC's SAR-filing workflow require a
  named-officer sign-off equivalent to ImmiStack's RMA rule, or is that a compliance/legal question
  for BUSINESS.md's GRC counterpart, which does not exist in this checkout?]`.
- **Verify against a GovX tenant before either enforcement (§9 step 6) or the §6 pack rename ships**,
  using the same census query (§11) with `vertical = 'grc'`. GRC has never materialised
  `workflow[].steps[].assignedRole` in the way AU immigration has — confirm with
  `SELECT count(*) FROM workflow_transitions wt JOIN workflows w ON w.id = wt."workflowId" WHERE
  w.vertical = 'grc' AND jsonb_array_length(COALESCE(wt.permissions->'roles','[]'::jsonb)) > 0` before
  assuming GRC even has gated transitions to lock anyone out of. If that count is zero, GRC's
  enforcement flip carries no backfill risk and can proceed with immigration's, or independently.
- **No GRC role name may be added to `PlatformRole` or to any file under `src/`** as a shortcut for a
  missing pack entry. If GRC needs a role the pack does not yet declare, that is pack authoring
  (§4.2 rule 2 — every array is additive), never a core change.

---

## 11. Census query — run before flipping enforcement

**Which tenants have materialised workflows carrying `permissions.roles`:**

```sql
SELECT w."tenantId", w.vertical, w.id AS "workflowId", w.name,
       wt.id AS "transitionId", wt.permissions -> 'roles' AS "requiredRoles"
FROM workflow_transitions wt
JOIN workflows w ON w.id = wt."workflowId"
WHERE w.status = 'active'
  AND jsonb_array_length(COALESCE(wt.permissions -> 'roles', '[]'::jsonb)) > 0;
```

**Which users would be locked out.** `required.role` values that are already `PlatformRole` members
(`platform_admin`, `firm_admin`, `staff`, `client`) never need a tag — they already resolve via
`checkPermissions`'s rule 3. Only non-`PlatformRole` requirements matter here. **Confirm the physical
type of `users.roles` before running this** — the entity declares `simple-array` (comma-joined
`text`), but migration `1738479999999-FixVerticalsAndColumns.ts` shows this column has been converted
between `text` and `text[]` at least once in this project's history; run `\d+ users` and adjust the
containment check accordingly. Written here assuming the current entity's stated type (`text`,
comma-joined):

```sql
WITH required AS (
  SELECT DISTINCT w."tenantId", w.vertical,
         jsonb_array_elements_text(wt.permissions -> 'roles') AS role
  FROM workflow_transitions wt
  JOIN workflows w ON w.id = wt."workflowId"
  WHERE w.status = 'active'
    AND jsonb_array_length(COALESCE(wt.permissions -> 'roles', '[]'::jsonb)) > 0
)
SELECT r."tenantId", r.vertical, r.role, u.id AS "userId", u.email
FROM required r
JOIN users u ON u."tenantId" = r."tenantId" AND u."deletedAt" IS NULL
WHERE r.role NOT IN ('platform_admin', 'firm_admin', 'staff', 'client')
  AND NOT (string_to_array(u.roles, ',') && ARRAY[r.role])       -- not satisfied via PlatformRole
  AND NOT (u."verticalRoles" && ARRAY[r.role]);                  -- not satisfied via practice tag
```

Every row returned is one (tenant, user, required-role) combination that would be denied the moment
enforcement ships. **This query must return zero rows before step 5 of §9 deploys**, and should be
re-run per tenant as part of step 6's "verify against a real tenant."

---

## 12. Options considered and rejected

- **A fifth `PlatformRole` value per practice role** (e.g. `MIGRATION_AGENT`, `PARALEGAL`). Rejected:
  `PlatformRole` is deliberately the *only* vocabulary the JWT `role` claim, portal routing and coarse
  `@Roles` guards understand (`src/iam/enums/platform-role.enum.ts`'s own doc comment says exactly
  this). Growing it per vertical reintroduces the vertical-vocabulary-in-core violation CLAUDE.md
  §5.5 exists to prevent, and GRC would need its own four more values, doubling the enum per vertical
  added — the opposite of the 6-week-per-vertical target.
- **Practice tags under `attributes`.** Rejected in §3 — no query ergonomics for the census check,
  and shares a mutation surface with `department` and any future free-form key.
- **Inferring a practice role from a user's transition history** ("they've completed 12
  case-coordinator-gated steps, so they must be one"). Explicitly rejected per the task brief: a
  practice role is a legal/regulatory attestation (§6's RMA Code of Conduct point), not a behavioural
  pattern. Inferring it from history would let an unregistered agent accumulate implicit authority
  simply by being assigned work, which is the exact failure mode the sign-off rule (§7) exists to
  prevent.
- **A feature flag for staged, per-tenant enforcement rollout.** Considered in §9 step 5 and rejected
  as unnecessary machinery — `FeatureFlagService` exists but has no runtime read path today, and the
  census-query-to-zero gate achieves the same safety with no new coupling.
- **Reusing `permissions.requireApproval`/`approvers` for sign-off.** Rejected in §7 — different
  semantics (named individuals vs. role-based regulatory attestation), and reusing a dead field
  without wiring its original meaning would leave two half-implemented concepts instead of one
  correct one.

---

## 13. Consequences

- **Good:** `checkPermissions` becomes strictly simpler (three branches, no evaluability distinction)
  and strictly more correct — every denial is now a real one. The pack's `roles[]`, already validated
  and stored (CLAUDE.md §4.1), finally has a reader. `signedOffBy` gives the Code-of-Conduct rule a
  data model instead of relying on `updatedBy`, which the ImmiStack doc already calls out as
  insufficient.
- **Unpleasant, accepted:** a practice-role grant is not instant — it takes effect on the tagged
  user's next token refresh (≤1 hour), identical to how a `PlatformRole` change already behaves. This
  is a real UX gap for a firm admin who grants a role and expects it to work immediately; if this
  proves unacceptable in practice, the fallback is a live `verticalRoles` DB read per transition
  check instead of a JWT claim, at the cost of one extra query per gated transition attempt — not
  chosen here because it is a strictly worse default for every request that is *not* a stale grant.
- **Unpleasant, accepted:** the pack rename (§6) means the AU pack's `assignedRole` strings and the
  already-materialised `permissions.roles` in any tenant that clicked "Materialise all" before the
  rename ships will disagree until that tenant re-materialises. This is not new risk this ADR
  introduces — it is the existing "materialisation is operator-triggered, not automatic" property
  (CLAUDE.md §16) — but it does mean §9's backfill is not a single global list; it must be verified
  per tenant, potentially twice (once for old vocabulary, once after re-materialisation for new).
- **Open, not addressed here:** `requireApproval`/`approvers` on `WorkflowTransition.permissions`
  remain dead code. GRC's sign-off equivalent (§10) is `[NEEDS DATA]`. The `manager`/`partner` pack
  roles (§6) do not exist yet — this ADR names them as required but does not author them.

---

## 14. What would make this decision wrong later — the trigger to revisit

- **If a practice role needs to gate something other than a workflow transition** — a document
  checklist item, a fee-schedule action, a report — `checkPermissions`'s pattern (roles ∪ users, no
  constraint = allow) would need to be generalised or duplicated. Revisit whether `verticalRoles`
  should be checked by a shared authorization primitive rather than being re-read at each call site,
  before a third consumer appears.
- **If a user legitimately needs different practice roles per matter/case rather than per tenant** —
  e.g. an `agent` who is also sometimes a `paralegal` on a specific file — this model cannot express
  it; `verticalRoles` is tenant-wide, not record-scoped. That would need a relationship (user × record
  × role), not a column, and is a materially bigger change. Nothing observed in the AU pack or the
  ImmiStack doc suggests this today; revisit only if a real product requirement surfaces it.
- **If GRC's `mlro` sign-off turns out to require more than one officer, or a quorum**, `signOffRole`
  as a single string cannot express it — that would need to become `signOffRoles: string[]` with an
  explicit `all`/`any` policy, at which point `permissions.roles`' existing `roles: string[]`
  (implicitly "any") sets the precedent to follow.
- **If `FeatureFlagService` gains a real runtime consumer elsewhere** (i.e., the "too much machinery"
  judgment in §12 stops being true because the wiring already exists for another reason), reconsider
  gating future enforcement flips of this kind through it rather than the census-to-zero pattern.

---

## 15. Verification checklist for Owen

- [ ] `checkPermissions` unit tests reflect the three-branch model; the two tests asserting the old
      deferral behaviour are replaced, not just weakened.
- [ ] `verticalRoles` migration is additive, reversible, and does not touch `roles`.
- [ ] Grant route rejects a tag not in the resolved pack, naming the pack code/version.
- [ ] Grant route audits every mutation via `AuditService`, not silently (confirm `IamModule` now
      imports `AuditModule`'s provider into this specific call path — it already imports the module,
      confirm the service is actually injected and called, not just available).
- [ ] Cross-tenant grant path explicitly binds `TenantContext.setTenantId(targetTenantId)` before
      resolving the pack — does not rely on ambient context inside `runAsGod`.
- [ ] `signedOffBy` is written on the history entry, never conflated with `triggeredBy`/`updatedBy`.
- [ ] The census query (§11) has been run against a real environment and returns zero rows before the
      PR that deletes the deferral branch is allowed to merge.
- [ ] No immigration vocabulary (`agent`, `paralegal`, `migration_agent`, …) appears anywhere under
      `src/`. Grep for it as part of review.
