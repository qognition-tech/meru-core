# 0008 — VAC and payment integrity (ImmiStack Tier 1.1–1.4)

> **Rescue and renumbering note (Jonas, 2026-09-08).** This ADR was authored 2026-09-03 on
> `fix/crm-entity-actor-scoping`, a lineage superseded and scheduled for deletion — it never
> reached `main`. It is renumbered **0001 → 0008** here because `main` already has a different,
> merged `0001-practice-role-tags.md`; the two are unrelated decisions that happened to be
> drafted with the same number on divergent branches. Its own numbering scheme (§ headings,
> cross-references) used no other self-reference to "0001", so nothing below needed touching for
> the renumbering itself.
>
> **The implementation has since shipped to `main`, unmerged from this document.** Verified this
> session: `verticalAttributes.vacStatus` and the `vacSettlementMode` field are live in
> `packages/config-packs/verticals/immigration.json` (`:1478`, `:2253`), the field-level
> immutability mechanism this ADR specifies (`lockedWhen`) is implemented in
> `src/crm/crm.service.ts:122-177` and used by the pack at `:2262`, and the pack's first
> `rules[]` entry — the VAC reconciliation rule this ADR's §10 open item concerned — is live at
> `immigration.json:2773`. `BackfillVacStatus1756600000000`
> (`src/migrations/1756600000000-BackfillVacStatus.ts`) is registered in `ALL_MIGRATIONS`
> (`src/config/migrations.ts:41,100`), so it runs on any environment that applies migrations in
> order; per the operator it has been applied to production and seeded 12 cases —
> `[UNVERIFIED: exact production row count]`, not checkable from this repo without a DB
> connection. The **Status** line below is corrected accordingly; the technical content that
> follows is otherwise unchanged from the 2026-09-03 draft, including its dated
> `/api-json` snapshot in the next block, which was accurate on the day it was taken and is kept
> as the historical record the ADR's own claims were verified against.

**Status:** Implemented — core of Tier 1.1–1.4 (`vacStatus`, `vacSettlementMode`, field-level
immutability, the first immigration `rules[]` entry, and the `BackfillVacStatus` migration) has
shipped to `main` and been applied to production. Not formally reviewed by `quality` (Owen)
against this document — it shipped via the superseded branch's own review path, not this ADR.
The card-authority record + PAN redaction guard (§4.3, Tier 1.3) and the duty floor (§4.5 /
Tier 1.4) were **not** found in a same-session grep of `src` and `packages` beyond what is cited
above — treat those two scopes as still open until reverified.

**Scope:** ImmiStack backlog items 1.1 `vacStatus`, 1.2 `vacSettlementMode`, 1.3 card-authority
record + PAN redaction guard, 1.4 duty floor. Specification is
`meru-core-fe/immistack/CLAUDE.md` §4.2–4.5.

**Verified against:** `/api-json` at `https://meru-core.vercel.app/api-json`, fetched
2026-09-03 — **273 paths / 325 operations**. Source at the file:line references below. Every
claim not carrying one is marked `[UNVERIFIED]`.

---

## 1. Context

### 1.1 What is greenfield

`vacStatus`, `vacSettlementMode`, `cardAuthority`, `card_authority`, `duty_floor`, `dutyFloor`
and `redact` return **zero matches** across `meru-core/src`, `meru-core/packages` and
ImmiStack's `app/`, `lib/`, `components/`. Additionally verified for this ADR: `commercial_hold`
and `commercialHold` also return **zero matches** in `meru-core/src` — the Tier-1
`commercial_hold` of §4.5 does not exist, so today **nothing in core can freeze anything except
the workflow arrears gate.** That bounds the duty floor considerably and is the single most
useful fact in this section.

### 1.2 What already ships and must be built on rather than around

| Capability | Evidence |
|---|---|
| Three kinds of money | `CreatePaymentDto.feeKind: government\|firm\|disbursement` and `direction: inbound\|outbound` — `/api-json`. §4.1 is **already implemented in core.** Nothing to build. |
| Pack `rules[]` evaluated on demand | `GET /api/v1/crm/entities/{id}/rules` → `PackRuleService.evaluate` (`src/rules/pack-rule.service.ts:63`), returning `{pack, evaluated, invalid, skipped, violations, blocked}` (`:22-34`). Synchronous. No scheduler. |
| Pack `alertRules[]` swept by a job | `src/rules/alert-rule.service.ts`, dispatched from `src/jobs/jobs.controller.ts:414` |
| Audited assent artifact | `POST /api/v1/crm/entities/{id}/acceptance` → `src/crm/acceptance.service.ts:75`; writes a hash-chained audit entry at `:129` |
| Document generation from the pack | `POST /api/v1/documents/generate/{templateKey}`; `documentTemplates` reaches the DB via `src/tenant/services/config-pack-loader.service.ts:466` |
| The arrears gate | `FeeScheduleService.arrearsBlocking` (`src/billing/fee-schedule.service.ts:265`), called from `src/workflow/workflow.service.ts:359` |
| `verticalAttributes` deep-merges | `src/crm/crm.service.ts:368` — *"merges rather than replaces, at every depth"* — implemented by `src/common/deep-merge.ts` |

### 1.3 Six findings that change the design

These are the reason this ADR exists rather than a ticket.

**F1 — `PackRuleService` skips a rule that reads *any* absent variable, not just a numeric
comparison.** `RuleEvaluatorService` guards only `COMPARISON_OPS` = `< <= > >= between`
(`src/rules/rule-evaluator.service.ts:139-145`), so `!=` against a missing field would evaluate
and fire. But `PackRuleService.missingVariables` (`src/rules/pack-rule.service.ts:136-167`)
walks **every** `{"var": …}` node and, if the record does not define it, the rule lands in
`report.skipped` and `blocked` stays `false`.

> Consequence: a matter at stage `lodged` that carries **no** `vacStatus` key produces
> `blocked: false`. A UI rendering `blocked` naively shows the most damaging state in the
> product as clean. **This is the §7.3 failure mode, reachable by omission.**

**F2 — `stage >= lodged` cannot be written as a comparison.** `>=` is a `COMPARISON_OP`, so a
record without `stage` skips the rule (F1 again); and JsonLogic `>=` on strings is
lexicographic, where `'decision' >= 'lodged'` is **false**. A `>=` rule would miss every decided
matter. `in` is on the operator whitelist (`rule-evaluator.service.ts:36`) and is not a
comparison op.

**F3 — `alert_firings` has no HTTP surface, and the sweep is at best daily today.**
No `/alerts*` path exists in the 273 checked. `src/rules/` contains no controller.
`JOB_CADENCE_MINUTES['alert-rules'] = 15` (`src/jobs/jobs.controller.ts:82`), and
`TICK_SCOPES.fast` is `<= 60` minutes (`:113`) — driven by an external scheduler that is
**ImmiStack Tier 0.4 and not configured**; the Vercel `scope=fast` cron runs `0 3 * * *`, i.e.
once a day. `AlertFiring` (`src/rules/entities/alert-firing.entity.ts`) also carries no
`dismissedAt`/`dismissedBy`/`dismissalReason`.

> Consequence: an `alertRules[]`-only implementation of §4.4 would fire at best once a day,
> could not be read by the UI at all, and has nowhere to record a dismissal.

**F4 — `PATCH /crm/entities/:id` writes no audit entry.** `CrmService.update`
(`src/crm/crm.service.ts:365-389`) calls `this.logger.log` and returns; there is no
`AuditService` call on the update path. §4.2 requires `vacSettlementMode` to be *audit-logged*
and §4.4 requires `verified` to record who and when. **A plain PATCH does not satisfy either.**

**F5 — the acceptance record is a closed shape.** `AcceptanceRecord`
(`src/crm/acceptance.service.ts:14-42`) is exactly `{subject, userId, email, acceptedAt, ip,
userAgent, documentSha256, isSignature}`, and `RecordAcceptanceDto` accepts only `subject` and
`documentSha256` (`/api-json`). It **cannot** carry `last4`, `brand`, a nominated maximum or an
expiry. The working hypothesis that the card authority "rides the acceptance artifact" is
therefore **half right** and is corrected in D3.

**F6 — a duty floor authored inside `workflows[].steps[].transitions[]` would be unsafe by
construction.** Per workspace `CLAUDE.md` §6, arrays merge by `identityOf` =
`['key','type','id','code']` in that order, and *if any overlay element lacks an identity the
whole base array is replaced*. `WorkflowStepSchema.transitions[]` elements are
`{to, label, condition}` (`packages/config-packs/_schema/pack.schema.ts:47-51`) — **no identity
key at all**. Worse, `WorkflowStepSchema` carries both `id` and `type`, so steps merge by
**`type`**, and `wf_visa_matter` has three steps of type `payment` (`signup_payment`, `apf`,
`lodgement_fee`) and four of type `review`. An overlay touching those steps collapses them.

### 1.4 Where the data actually lives today

`verticalAttributes.matter.stage` and `verticalAttributes.visaSubclass` —
`lib/api/services/matters.service.ts:111` (create) and `:138-146` (stage change). Thirteen
stages in `lib/workflow/visa-lifecycle.ts:66-79`: `intake, cost_agreement, signup_payment,
portal_access, document_request, health_insurance, drafting, client_approval, apf,
lodgement_fee, lodged, decision, closed`. The AU pack's `wf_visa_matter` uses **the same step
ids** (`packages/config-packs/countries/au-immigration.json`), plus `art_review`.

The pack's own `entityTypes[case].fields[]` uses **flat** keys — `visaSubclass`, `applicantId`,
`lodgedAt`, … (`packages/config-packs/verticals/immigration.json`). So the pack convention is
flat and the frontend's matter blob is nested. Both resolve, and D1 pins which to use.

> **Correction to a comment in the frontend.** `lib/api/services/matters.service.ts:127-130`
> states that `verticalAttributes` "is replaced wholesale by the API, not deep-merged". That is
> **false** — `src/crm/crm.service.ts:368` and `src/common/deep-merge.ts` merge recursively, and
> `/api-json` says so on `UpdateEntityDto`. Harmless today because over-sending is idempotent,
> but it is exactly the reasoning that would lead someone to build 1.1 and 1.2 wrongly. Mira to
> fix the comment.

---

## 2. Decisions

### D1 — `vacStatus` is a required vertical attribute with a default, not an optional one

**Decision:** `vacStatus` lives at `verticalAttributes.vacStatus` on `type=case`. It is written
`'unpaid'` at matter creation, is **never absent and never `null`**, and existing matters are
backfilled. No core column, no core enum, no core change.

**Placement rationale (80/20, workspace §7.1).** "Visa Application Charge" is immigration
vocabulary. Core knows "a record that can be worked". A `vacStatus` column in
`universal_entities` would be the archetypal violation. `verticalAttributes` is the sanctioned
home (§7.5) and is already how `visaSubclass` and `stage` are stored.

**Why flat rather than under `matter.`.** Three reasons, in order of weight: it matches the
pack's existing `entityTypes[case].fields[]` convention (all flat); `PackRuleService` builds its
evaluation context as `{...verticalAttributes, ...record}` — one level
(`src/rules/pack-rule.service.ts:83`) — so a flat key resolves directly; and
`RuleEvaluatorService.augment` flattens `verticalAttributes` one level unconditionally
(`rule-evaluator.service.ts:247`) but reaches the second level only through a special case
(`:262-286`). Flat works in more places with fewer edge cases.

> **The asymmetry, stated so it is not re-litigated.** `stage` stays at
> `verticalAttributes.matter.stage` because moving it is a data migration on live matters and is
> out of scope here. So a pack rule reads `{"var":"matter.stage"}` and `{"var":"vacStatus"}` in
> the same expression. Both resolve — `PackRuleService`'s dotted reduce (`:155-165`) walks
> `data.matter.stage`, and `augment` keeps `matter` as a nested object (`:281`). Ugly, correct,
> and deliberate. **Do not "fix" it by moving one without migrating the other.**

**Why required-with-a-default is the whole point.** Per F1, an absent `vacStatus` makes the
reconciliation rule `skipped` and `blocked: false`. The rule is only sound if the field always
exists. Hence: default at creation, backfill on deploy, and **never PATCH `vacStatus: null`** —
`deepMerge` treats `null` as *delete the key* (`src/common/deep-merge.ts`), which would silently
re-open the hole.

**Contract — `verticalAttributes` keys on `type=case`:**

```jsonc
{
  "vacStatus": "unpaid | evidence_pending | verified",   // required, default "unpaid"
  "vacVerification": {                                    // present only when vacStatus === "verified"
    "verifiedBy":   "<users.id>",
    "verifiedAt":   "<ISO-8601>",
    "evidenceKind": "immiaccount_receipt | lodgement_confirmation_trn | outbound_payment_plus_receipt | bank_statement_line",
    "evidenceDocumentId": "<documents.id> | null",
    "trn": "<string> | null"
  },
  "vacAlertDismissals": [                                 // append-only; never rewritten
    { "by": "<users.id>", "at": "<ISO-8601>", "reason": "<string, min 20 chars>" }
  ]
}
```

`vacStatus: 'verified'` requires `vacVerification.verifiedBy`, `verifiedAt`, and **either**
`evidenceDocumentId` **or** `trn` — §4.4. `bank_statement_line` is accepted but must render as
weaker evidence.

**Client self-report.** A `client`-role actor may cause `evidence_pending` only, and must never
be able to write `verified`. Per workspace §8, **RLS isolates tenants, not users inside a
tenant**, and this has already been missed three times on `/crm/entities`, `/payments` and
`/communications/threads`. `PATCH /crm/entities/:id` is reachable by a client token
`[UNVERIFIED: whether CrmService.update applies any role or ownership scoping to
verticalAttributes writes — Luke to confirm before building the client-side flow]`. Until that
is confirmed, **the client self-report must not be a direct PATCH.** It goes through an ImmiStack
route handler that writes `evidence_pending` and opens a staff task, and nothing else.

### D2 — the reconciliation alert is a pack `rules[]` entry first, an `alertRules[]` entry second

**Decision:** §4.4's blocking alert is authored as a `rules[]` entry with
`severity: "error"`, read synchronously through the existing `GET /crm/entities/:id/rules`. An
`alertRules[]` entry is authored alongside it as the *push* complement, and is honestly labelled
as at-best-daily until Tier 0.4 lands.

**Why not `alertRules[]` alone.** F3: at best a daily sweep, invisible to the UI (no route on
`alert_firings`), and no dismissal columns. Building §4.4 on it would produce an alert that
cannot be seen and cannot be acknowledged.

**Why `rules[]` works.** `GET /crm/entities/{id}/rules` already exists and already returns
`blocked: true` when an `error`-severity rule matches (`src/rules/pack-rule.service.ts:113`).
No scheduler, no new route, no core code.

**The rule, exactly — for the pack author.** Goes in
`packages/config-packs/countries/au-immigration.json` under a new `rules[]` array. `rules` is
already in the loader's key list (`config-pack-loader.service.ts:457`) and is **absent from both
immigration packs today**, so this is purely additive.

```json
{
  "key": "vac_not_verified_after_lodgement",
  "label": "Recorded as lodged, but the visa application charge is not verified",
  "severity": "error",
  "message": "This matter is at stage {{matter.stage}} but vacStatus is {{vacStatus}}. An application is not validly made unless the charge is paid.",
  "when": {
    "and": [
      { "in":  [ { "var": "matter.stage" }, ["lodged", "decision", "closed"] ] },
      { "!=": [ { "var": "vacStatus" }, "verified" ] }
    ]
  }
}
```

`in` rather than `>=`, per F2. `!=` rather than `<`/`>` so the operator is not caught by the
comparison guard.

**Rendering contract — binding on Mira.** The report has three outcomes and only one of them is
clean:

| Report | Render |
|---|---|
| `violations` contains `vac_not_verified_after_lodgement` | **BLOCKING banner.** Un-dismissable without a reason string of ≥20 characters |
| `skipped` contains `vac_not_verified_after_lodgement` | **"Cannot determine — payment status missing."** Never clean, never green. This is F1 surfacing |
| `invalid` contains it | **"Alert misconfigured"**, surfaced to `firm_admin` — an authoring error, not a pass |
| absent from all three, `blocked: false` | clean |

**Dismissal.** Appended to `verticalAttributes.vacAlertDismissals[]` **and** written as an
internal comment via `POST /crm/entities/:id/comments`. Two records because of F4: the PATCH is
not audited, and the comment is the durable one.
`[UNVERIFIED: whether CommentService writes an audit_logs entry — src/crm/comment.service.ts:61
not read for audit calls. Luke to confirm; if it does not, D6's pack-declared `audited` flag
must cover the dismissal too.]`

### D3 — the card authority splits: the pack holds the terms, acceptance holds the assent, `verticalAttributes` holds the reference

**Decision, and it corrects the working hypothesis.** Per F5 the acceptance record is a closed
shape and cannot carry the authority's fields. Three parts, **none of which is a core change**:

1. **Terms** — a new `documentTemplates[]` entry `vac_card_authority` in
   `verticals/immigration.json`, rendered by the existing
   `POST /documents/generate/vac_card_authority`. This produces the exact bytes shown.
2. **Assent** — `POST /crm/entities/:id/acceptance` with
   `{ "subject": "vac_card_authority", "documentSha256": "<sha of those bytes>" }`. Audited and
   hash-chained at `src/crm/acceptance.service.ts:129`. Appends, never replaces (`:118-122`), so
   a revised authority does not erase the one that governed earlier.
3. **Reference data** — `verticalAttributes.vacCardAuthority` on the matter.

```jsonc
{
  "vacCardAuthority": {
    "brand": "visa | mastercard | amex | other",     // from a pack-authored list
    "last4": "1234",                                  // ^[0-9]{4}$ — exactly four, staff-typed
    "maxAmountMinor": 145000,                         // integer minor units
    "currency": "AUD",
    "purpose": "<string>",                            // e.g. "Subclass 482 application charge"
    "authorisedUserId": "<users.id>",
    "acceptanceSha256": "<64 hex>",                   // ties to the acceptance record
    "expiresAt": "<ISO-8601>",                        // default: min(lodgement, capturedAt + 30d)
    "revokedAt": "<ISO-8601> | null",
    "revokedBy": "<users.id> | null",
    "revocationReason": "<string> | null"
  }
}
```

**Why not extend `RecordAcceptanceDto` with a metadata bag.** Rejected deliberately. The
acceptance record's value is that it is a *closed, audited* shape shared with GovernanceX; an
open bag on it is precisely where a PAN would eventually be written, by exactly the well-meaning
code path §4.3 exists to prevent. The narrow DTO is a feature.

**Field constraints that are load-bearing, not cosmetic.** `last4` is `^[0-9]{4}$` — anchored,
exactly four — so a pasted PAN is rejected by shape before the detector is even consulted.
`brand` is an enum. There is no free-text field on this object other than `purpose` and
`revocationReason`, and both are scanned by D4.

### D4 — the PAN detector is generic core, pack-gated, and defaults to inert

**Decision:** a card-data detector is a **generic core capability** — GovernanceX wants it too,
and it is regulatory plumbing, which is the decision-tree's own answer
(`immistack/AGENTS.md` §2). It is **not** globally on. Its enforcement mode is read from the
pack and defaults to `off`.

**Why pack-gated rather than a global `APP_INTERCEPTOR`.** The write paths are shared with
GovernanceX. A global blocker on `/communications/*` and `/crm/entities/:id/comments` would fire
on GRC trade-finance content — instrument numbers, IBANs, vessel and counterparty references —
and blocking a GovX message is exactly the cross-vertical breakage workspace §7.2 forbids. Core
does not decide; the pack does.

**Pack surface** — nested under `compliance`, which is **already** in the loader's key list
(`config-pack-loader.service.ts:439`):

```jsonc
"compliance": {
  "cardDataGuard": {
    "mode": "off | warn | block",   // default "off"
    "redactExtraction": false        // default false
  }
}
```

**Detector.** Luhn-validated candidate sequences of 13–19 digits, tolerating spaces and hyphens
as separators. Luhn is the load-bearing part — a bare `\d{13,19}` false-positives on invoice
references and IMO numbers at a rate that would get the guard switched off, which is the same
outcome as not building it. CVV and expiry patterns are flagged **only when co-located with a
Luhn-valid candidate**; a bare three-digit number is not evidence of anything.

**Attachment points — exactly three, named:**

| Path | Field | Action on hit when `mode: block` |
|---|---|---|
| `src/crm/comment.service.ts:61` | `body` — file notes | **Reject, HTTP 422.** The author can retype |
| `src/notifications/thread.service.ts:35` and `:53` | `content` — message bodies | **Reject, HTTP 422** |
| `POST /documents/:id/analyze` output, before persistence | extracted text | **Redact and flag, never reject** |

**Why extraction redacts rather than blocks — this is a real decision, not an oversight.**
Rejecting an OCR/AI result discards the analysis of a document the user cannot retype and cannot
fix. The failure economics are inverted: on a typed field, blocking costs the author ten
seconds; on an extracted document, blocking costs the analysis entirely and the user's only
recourse is to stop using the feature. So extraction stores the redacted text plus a flag, and
the flag opens a staff task. §4.3 says "blocks and warns" — this ADR narrows that to *blocks
what a human typed, redacts what a machine read*, and records why.

**Three constraints on the implementation, all of which are the difference between a guard and
an incident:**

1. **The guard must never log the matched text.** Log the field name, the byte offset and the
   length. A detector that writes the PAN into `audit_logs` or a Vercel log line has moved the
   breach rather than prevented it — and `audit_logs` is append-only by trigger (workspace §7.7),
   so it cannot be cleaned up afterwards.
2. **Every scan records that it ran**, with the detector version, so a later improvement can
   identify what was written under the older detector. Absent that, an improved regex tells you
   nothing about the back catalogue.
3. **A rejection message must not echo the input.**

**Failure mode when the regex misses — stated plainly.** It is a net, not a control. A PAN that
does not Luhn-validate, is split across a line break, or arrives inside an image the OCR does not
read, **is stored.** The real control is the out-of-band handling in §4.3 and the fact that the
authority record makes storing a PAN unnecessary. **This guard must not be described to a
customer, in a security page or a tender response, as PCI compliance or as a control.** It
reduces accidental capture; it does not prevent deliberate or unlucky capture.

### D5 — the duty floor is a vertical-wide pack list read by the existing arrears gate

**Decision:** the floor is authored at `compliance.dutyFloor` and consulted by
`FeeScheduleService.arrearsBlocking`. §4.5 explicitly requires "a pack-level list of protected
transitions, not a hardcoded exception", and this is the smallest change that delivers it.

**Why `compliance.dutyFloor` and not the three alternatives:**

- **Not inside `workflows[].steps[].transitions[]`** — F6. Those elements have no identity key,
  so an overlay replaces the whole array, and steps merge by `type`, which collapses the three
  `payment` steps. Authoring a regulatory floor in the one place the merge algorithm is least
  predictable would be a poor trade.
- **Not on `paymentPlans[]`** — the floor is a property of the firm's professional obligations,
  not of a commercial plan. Per-plan authoring means a plan authored without a floor has no
  floor, which is the exact regulatory failure being prevented.
- **Not a new top-level `dutyFloor` key** — it would make this a three-part commit
  (Zod + `npm run packs:schema` + the 23-key list in `upsertPack`), and workspace §6 records that
  missing the third part means the array validates, persists nowhere and is read by nobody.
  `compliance` is already listed at `config-pack-loader.service.ts:439`, so nesting under it is a
  **two-part commit** with no loader change and no risk of that failure.

**Pack surface:**

```jsonc
"compliance": {
  "dutyFloor": {
    "protectedSteps": ["lodged", "decision", "art_review", "closed"],
    "protectedTransitions": [ { "from": "decision", "to": "art_review" } ],
    "neverGated": ["client_document_read", "client_document_export", "client_messaging"],
    "requireReason": true
  }
}
```

> `protectedTransitions[]` elements carry no `key`/`type`/`id`/`code`, so a country overlay
> **replaces** this array rather than adding to it. That is the correct semantic for a floor —
> a country states its own complete floor — but it must be written down, because the default
> expectation from `fees[]` and `paymentPlans[]` is additive merge.

**Core change — one optional parameter, additive:**

```ts
// src/billing/fee-schedule.service.ts:265 — signature today plus one optional argument
arrearsBlocking(
  tenantId: string,
  vertical: string | null,
  entityId: string,
  stepKey: string,
  toStepKey?: string,          // NEW — the step being entered
): Promise<Payment[]>
```

Returns `[]` when `toStepKey` is in `protectedSteps`, or when `{from: stepKey, to: toStepKey}`
matches `protectedTransitions`. The single call site
(`src/workflow/workflow.service.ts:359`) passes `transition.toState.name`.

**Audit.** Every release granted by the floor writes an `AuditService.logEvent` with
`entityType: 'duty_floor_release'`, `severity: WARNING`, and the step pair and reason.
§4.5: *"that log is what proves the firm behaved properly."* A floor with no log is worth
nothing in the dispute it exists for.

**Load-time validation.** The loader already warns when `fees[].atStep` or
`paymentPlans[].stages[].atStep` names no workflow step
(`src/tenant/services/config-pack-loader.service.ts:154-187`). Extend the same check to
`dutyFloor.protectedSteps` and `protectedTransitions`. A typo'd floor must be a loud authoring
error, because a floor that silently protects nothing is worse than no floor: someone believes
they have one.

**The half of the floor that is a negative constraint, not code.** Client read/export of their
own documents and client messaging are not workflow transitions and are **not gated by anything
today** — §1.1, `commercial_hold` has zero matches in `meru-core/src`. The decision is therefore:
`neverGated[]` is authored now as the standing statement of intent, and **the future
`commercial_hold` must never be wired into `DocumentAccessService`, `StorageService.checkAccess`
or `ThreadService`.** Owen to add a regression spec asserting no hold state reaches those three.
This costs nothing today and is the cheapest possible insurance against a later change that would
be a Code of Conduct problem.

### D6 — `vacSettlementMode`, and the one core change with real blast radius

**Decision:** `vacSettlementMode` lives at `verticalAttributes.vacSettlementMode`. Four values,
nothing inferred. Its two hard requirements — *required before `lodgement_fee`* and *immutable
after lodgement* — are met by three mechanisms of differing strength, and the ADR is explicit
about which is which.

```jsonc
{ "vacSettlementMode": "firm_pays_on_behalf | client_pays_direct | client_card_agent_enters | third_party_payer" }
```

There is **no fifth "unknown" value and no default.** Absence means not yet set, and absence is
what the gate keys on. A default would be inference, which §4.2 forbids in its first line.

**Mechanism 1 — the pack workflow transition condition (correct, currently inert).** On the
`client_approval → lodgement_fee` and `apf → lodgement_fee` transitions in
`au-immigration.json`'s `wf_visa_matter`:

```
vacSettlementMode in ['firm_pays_on_behalf','client_pays_direct','client_card_agent_enters','third_party_payer']
```

This compiles under `PackWorkflowService.compileCondition`'s documented grammar
(`<path> <op> <literal>` | `in [...]` | `not in [...]`) and fails **closed**: an unset mode makes
`in` false, and the transition never opens. A condition that will not compile is stored as
`conditions.unevaluable` and that transition never opens either — a visible authoring error, not
a silent allow.

> **But it does nothing today.** ImmiStack changes stage by PATCHing
> `verticalAttributes.matter.stage` (`lib/api/services/matters.service.ts:138-146`), **not** by
> `POST /workflows/instances/:id/transition`. The frontend says so itself at
> `matters.service.ts:14-18`. Until matters are workflow-instance-backed, no workflow condition
> gates anything. Author it now anyway: it costs one line, it is the correct enforcement, and it
> becomes live the moment that migration happens.

**Mechanism 2 — a pack `rules[]` entry (advisory, works today).** `severity: "error"`, matching
"stage is `lodgement_fee` or beyond and `vacSettlementMode` is not one of the four", surfaced via
`GET /crm/entities/:id/rules`. **Read-only — `PackRuleService` does not block a write**, by
design (`src/rules/pack-rule.service.ts:38-45`), because a rule that silently refuses a PATCH is
the §7.2 breakage. So this reports; the UI acts.

**Mechanism 3 — the one real server-side block, and the only core change here with blast
radius.** Immutability after lodgement, and F4's audit gap, are the same problem: `CrmService`
must know that some fields are special without learning what a visa is. One extension to the pack
covers both:

```ts
// packages/config-packs/_schema/pack.schema.ts — entityTypes[].fields[], nested inside a key
// already in the loader's list (config-pack-loader.service.ts:443). Two-part commit.
{
  key: z.string(),                        // dotted path into verticalAttributes, e.g. "vacSettlementMode"
  // ... existing ...
  lockedWhen: z.unknown().optional(),     // JsonLogic, evaluated against the PRE-UPDATE record
  audited: z.boolean().optional(),        // write an audit_logs entry when this field changes
}
```

`CrmService.update` evaluates `lockedWhen` against the record **as it stands before the patch**,
through `RuleEvaluatorService`, and rejects a change to a locked field with **409 Conflict**.
For `vacSettlementMode` the pack authors
`lockedWhen: {"in": [{"var":"matter.stage"}, ["lodged","decision","closed"]]}`, and
`audited: true` on `vacSettlementMode`, `vacStatus` and `vacVerification`.

**Why this is generic and not immigration leaking into core.** Core learns "a pack may declare a
field frozen under a condition, and a pack may declare a field audited". It learns nothing about
visas, lodgement or charges. GovernanceX wants both — a closed breach's finding date and an
attested control test are the same shape.

**Why it is still the riskiest item in this ADR.** `PATCH /crm/entities/:id` is the hottest
shared route in the product. The safety is structural rather than intentional: absent
`lockedWhen` there is no lock, absent `audited` there is no extra write, and **no GRC pack
declares either** — `verticals/grc.json` `entityTypes[]` covers `screening_match, vendor,
control_test, risk_scenario, milestone, rfi, turnover_record, knowledge_article,
training_module, obligation, breach` and none of their fields carry these keys, because the keys
do not exist yet. GovernanceX behaviour is byte-identical. It still gets its own commit, its own
GovX regression run and its own review.

**The fallback, if Owen judges the blast radius unacceptable for Tier 1.** Enforce immutability
in the ImmiStack route handler only, accept that a direct API caller can change the mode after
lodgement, and rely on the audit trail to *detect* rather than *prevent*. That is a written,
owned risk acceptance — not a silent gap. D6 is the recommendation; the fallback is the escape
hatch, and taking it must be recorded here.

---

## 3. Does the pack contract need extending?

**No new top-level pack key, for any of 1.1–1.4.** Every addition nests under a key already in
`upsertPack`'s 23-key list (`src/tenant/services/config-pack-loader.service.ts:436-470`):

| Addition | Nests under | Already in the loader list |
|---|---|---|
| `rules[]` entries (D2, D6) | `rules` | Yes — `:457` |
| `alertRules[]` entry (D2) | `alertRules` | Yes — `:458` |
| `documentTemplates[].vac_card_authority` (D3) | `documentTemplates` | Yes — `:466` |
| `compliance.cardDataGuard` (D4) | `compliance` | Yes — `:439` |
| `compliance.dutyFloor` (D5) | `compliance` | Yes — `:439` |
| `entityTypes[].fields[].lockedWhen` / `.audited` (D6) | `entityTypes` | Yes — `:443` |
| workflow transition `condition` (D6) | `workflows` | Yes — `:437` |

**Therefore each is a TWO-part commit** — extend the Zod schema in
`packages/config-packs/_schema/pack.schema.ts`, then regenerate with
`npm run packs:schema` — **not the three-part commit** workspace §6 warns about. The 23-key list
is untouched and `config-pack-loader.service.spec.ts`, which regex-matches the loader's own
source, stays green.

> This was worth checking rather than assuming. The three-part rule is real and the failure it
> prevents is nasty, but it applies to **top-level** keys only. Nesting under an already-persisted
> key is what makes these changes cheap, and it is the main reason D4 and D5 sit under
> `compliance` rather than getting keys of their own.

**Pack version bumps — mandatory or the loader writes nothing** (workspace §6, rule 4: packs only
upgrade on a strictly greater version):

- `packages/config-packs/verticals/immigration.json` — **2.3.0 → 2.4.0** (documentTemplates, compliance)
- `packages/config-packs/countries/au-immigration.json` — **2.4.0 → 2.5.0** (rules, alertRules, workflow conditions, compliance, entityTypes)

> Note for whoever updates the docs: workspace `CLAUDE.md` §5 records `au` at **2.3.0**. The file
> on disk is **2.4.0**. The doc is stale by one; bump from what is on disk, not from the table.

---

## 4. The stacking rule — why GovernanceX is unaffected, per change

Workspace §7.2. Baselines: ImmiStack sweep **33/33**, GovX **27/28**. Re-run both after *every*
change; if ImmiStack drops, stop and revert.

| Change | Touches | Why GovX is unaffected |
|---|---|---|
| D1 `vacStatus` attributes | Nothing in `src/` | Vertical attributes on immigration matters. GRC packs never read them |
| D2 `rules[]` / `alertRules[]` | Nothing in `src/` | Authored in `au-immigration.json`. `VerticalPackService` resolves by the tenant's stored vertical; a GRC tenant never sees them. `verticals/grc.json` carries **no** `rules[]` today |
| D3 card authority | Nothing in `src/` | New `documentTemplates[]` entry in the immigration pack; existing routes, unchanged DTOs |
| D4 PAN detector | `comment.service.ts`, `thread.service.ts`, documents analyze | Enforcement reads `compliance.cardDataGuard.mode`, default `"off"`. No GRC pack declares the key — it does not exist yet — so every GovX write path is byte-identical. **Ship the core code and the pack flag in separate commits**, so the core commit is provably a no-op |
| D5 duty floor | `fee-schedule.service.ts:265` +1 optional param; `workflow.service.ts:359` passes it | Returns `[]` early only when `compliance.dutyFloor` is present. No GRC pack declares it → identical result set. `verticals/grc.json` has `paymentPlans: []`, so the arrears gate is inert for GovX regardless |
| D6 `lockedWhen` / `audited` | `crm.service.ts:365` update path | Both fields optional and absent from every GRC `entityTypes[].fields[]`. No lock evaluated, no audit row written. **Highest blast radius in this ADR — its own commit, its own GovX verification against a real GRC tenant** |

**Not touched, deliberately:** no `EntityType` enum value added (the 20 in `CreateEntityDto` are
sufficient — a matter is `type=case`, a card authority is an attribute, not an entity); no
entitlement `ModuleCode` added or applied; no route ImmiStack already calls gains a new guard;
no migration rewrites live grant data. Workspace §7.2's worked example is about exactly that
class of change, and this ADR contains none of it.

---

## 5. Ordering, and what must land together

**No database migration is required by this ADR.** That is a deliberate outcome of D2 (dismissal
on the matter rather than new `alert_firings` columns) and D1 (vertical attributes rather than
columns). The only data operation is a backfill, below.

| # | Ships | Depends on | Independent? |
|---|---|---|---|
| 1 | **D1 write path + backfill** — `vacStatus: "unpaid"` at matter creation; backfill existing `type=case` records | — | Yes. Safe alone: adds a key nothing reads yet |
| 2 | **D2 pack `rules[]` + Mira's three-state rendering** | 1 | **Must land together.** See below |
| 3 | **D3 card authority** — pack template + FE capture | — | Yes. Fully independent of 1, 2, 4, 5 |
| 4 | **D4a PAN detector core code**, `mode` default `off` | — | Yes. Provably a no-op |
| 5 | **D4b** flip immigration pack to `mode: "block"` | 4 | Yes, after 4 has been observed inert |
| 6 | **D5 duty floor** — pack `compliance.dutyFloor` + `arrearsBlocking` param + loader validation | — | Yes. **Must precede any `commercial_hold` work** |
| 7 | **D6 `lockedWhen`/`audited`** + pack authoring + workflow conditions | 1 | Yes. Last, own GovX regression run |

**Why 1 and 2 must land together, and 2 must not precede 1.** With the rule authored but
`vacStatus` absent, F1 puts the rule in `skipped` and returns `blocked: false` for every matter.
If the UI has not yet learned to render `skipped` as "cannot determine", it renders clean — and
the specific thing rendering clean is "this matter is lodged and the charge may never have been
paid". **That is the §7.3 defect the item exists to prevent, introduced by the fix for it.**
Ship the backfill first, the rule and the renderer together, and verify on a matter at stage
`lodged` before enabling for any tenant.

**Backfill.** A one-off script setting `verticalAttributes.vacStatus = 'unpaid'` on every
`type=case` row that lacks the key, per tenant, through the ordinary tenant-scoped path — **not**
a raw SQL `UPDATE` against the control-plane database, which would run as the owner role and
bypass RLS (workspace §8). Verify the count before and after, per tenant. `'unpaid'` is the
correct backfill value for every matter regardless of true state, because it is the honest
default: no evidence has been recorded. It will make some already-paid matters alert, and that is
the right direction to be wrong in.

---

## 6. Consequences, including the unpleasant ones

1. **The backfill will light up existing lodged matters.** Every matter at `lodged` or beyond
   gets a blocking banner on day one, because none of them has verified evidence. That is
   correct — the system genuinely does not know — but it is a support event and firms must be
   told before the deploy, not after. An alert that arrives unannounced on every open file is an
   alert that gets dismissed as a bug.
2. **`vacSettlementMode` immutability is advisory until D6 lands, and D6 is the riskiest item.**
   Between shipping 1.2's attribute and shipping D6, a direct API caller can change the mode
   after lodgement. Detected by audit, not prevented.
3. **The workflow transition conditions are inert on arrival** and stay inert until ImmiStack
   matters are workflow-instance-backed. Anyone reading the pack will see a gate that is not
   gating. The `condition` strings are authored anyway, and this paragraph is why.
4. **The PAN guard will produce false positives** and someone will ask for it to be switched off
   for a tenant. `mode` is per-pack, not per-tenant, so the answer is a tenant pack overlay — not
   an `if (tenant === 'x')`, which `immistack/AGENTS.md` §2 forbids by name.
5. **The duty floor protects only workflow transitions.** The three `neverGated` capabilities are
   a statement of intent with a regression test behind them, not an enforced control, because
   there is nothing yet to enforce against.
6. **Two rendering paths must agree about `skipped`.** `GET /crm/entities/:id/rules` returns it
   honestly; every consumer must handle it. A second consumer added later that ignores `skipped`
   reintroduces the defect silently.
7. **The flat/nested asymmetry in `verticalAttributes` is now load-bearing.** Rules read
   `matter.stage` and `vacStatus` in one expression. Recorded in D1 so it is not "tidied".

---

## 7. What would make these decisions wrong later

| Trigger | Which decision it invalidates | What to do |
|---|---|---|
| ImmiStack matters move onto real workflow instances (`POST /workflows/instances/:id/transition`) | D6 mechanisms 1 and 2 | Mechanism 1 becomes the real gate. Demote the `rules[]` entry to advisory and re-check that mechanism 2 is not double-reporting |
| An external scheduler is configured for `/jobs/tick?scope=fast` (Tier 0.4) | D2's ranking | `alertRules[]` becomes viable at 15-minute cadence. `rules[]` stays primary — it is synchronous and the UI reads it directly — but the push complement becomes genuinely useful |
| A read API and dismissal columns are added to `alert_firings` | D2's dismissal placement | Move dismissal from `verticalAttributes` to the firing row. Migrate the existing array |
| `CrmService.update` gains unconditional audit logging | D6's `audited` flag | The flag becomes redundant. Remove it rather than leave two mechanisms |
| A third vertical appears with its own money model | D5's `compliance.dutyFloor` shape | Re-check that a vertical-wide floor is still the right grain; a per-matter-type floor may be needed |
| The PAN detector's false-positive rate causes a tenant to demand `mode: "off"` | D4 | Tenant pack overlay. If more than one tenant asks, the detector is wrong, not the config |
| Meru adopts a real e-signature provider (Tier 1.9) | D3 part 2 | The card authority's assent should move from the acceptance artifact to a signed instrument. The `acceptanceSha256` field becomes a signature reference |
| Anyone proposes a top-level `dutyFloor` or `cardDataGuard` pack key | D4, D5 placement | Re-read workspace §6. It becomes a three-part commit and the third part is the one that gets missed |

---

## 8. Rollback

Per change, in the order they would be undone.

| Change | Rollback | Data left behind |
|---|---|---|
| D1 attributes + backfill | Nothing to revert in code. The keys are inert if nothing reads them | `vacStatus: "unpaid"` on every case. Harmless — `verticalAttributes` is an open bag. **Do not "clean up" by PATCHing `null`**: that deletes the key and reopens F1 |
| D2 pack `rules[]` | Remove the `rules[]` entry, bump `au-immigration.json` to the next patch version, reload via `POST /platform/config-packs/reload`. **A lower version writes nothing** | `vacAlertDismissals[]` entries persist. Correct — they are a record of decisions taken |
| D3 card authority | Remove the `documentTemplates[]` entry and bump. Existing acceptance records are append-only and **must not be deleted** — they are the audited evidence the authority was given | `vacCardAuthority` objects persist |
| D4a detector code | Revert the commit. The three call sites return to unguarded | None |
| D4b `mode: "block"` | Set `mode: "off"` and bump. Faster than reverting code, which is why the flag exists | Redacted extraction output is **not recoverable** — re-run analyze on affected documents |
| D5 duty floor | Two-step: remove `compliance.dutyFloor` and bump (restores today's gate behaviour), then revert the optional param if desired. **Reverting the param alone while the pack still declares a floor silently removes the floor** — do it in this order | `duty_floor_release` audit entries persist. Append-only by trigger; they cannot be removed |
| D6 `lockedWhen`/`audited` | Remove the field keys from the pack and bump — this disables both immediately with no deploy. Then revert the `crm.service.ts` commit | Audit rows persist and are append-only |

**Rollback verification, every time:** re-run the ImmiStack sweep (**33/33**) and the GovX sweep
(**27/28**). A rollback that drops either is not a rollback.

---

## 9. What this ADR deliberately does not decide

- **The `commercial_hold` itself** (§4.5 Tier 1). Only the floor that constrains it. The hold is
  a larger design and putting it in the same document would have let the floor be negotiated
  down alongside it.
- **Whether `CrmService.update` should audit unconditionally.** F4 is a genuine core gap wider
  than this ADR — *no* entity update is audited today, on either vertical, which sits awkwardly
  beside workspace §7.7. D6's pack-declared `audited` flag is the narrow fix. The wide fix needs
  its own ADR and a look at hash-chain write volume.
- **Whether `client`-role tokens can write `verticalAttributes` at all.** Flagged in D1 as
  `[UNVERIFIED]` and blocking the client self-report flow. This is the fourth instance of a class
  that has already shipped three times (workspace §8) and deserves Anton (`secops`), not an
  inline assumption here.
- **Moving `stage` out of `verticalAttributes.matter`.** A data migration on live matters, and
  the asymmetry it would fix is documented rather than expensive.
- **The evidence pack (Tier 2.1)** and **disputes (2.5)**, which consume `vacStatus`,
  `vacVerification` and `feeKind` but do not constrain their shape.
- **A per-tenant override of `compliance.cardDataGuard.mode`.** Mechanically a tenant pack
  overlay; not authored here because no tenant has asked and a hypothetical override is how
  overlays proliferate.

---

## 10. Open items for the implementers

| # | Item | Owner |
|---|---|---|
| 1 | `[UNVERIFIED]` Does `CrmService.update` apply role/ownership scoping to `verticalAttributes` writes? Blocks the D1 client self-report flow | Luke, with Anton |
| 2 | `[UNVERIFIED]` Does `CommentService` (`src/crm/comment.service.ts:61`) write an `audit_logs` entry? Determines whether D2's dismissal needs `audited: true` | Luke |
| 3 | Fix the false comment at `meru-core-fe/immistack/lib/api/services/matters.service.ts:127-130` — `verticalAttributes` deep-merges (`src/crm/crm.service.ts:368`) | Mira |
| 4 | Confirm the brand list for `vacCardAuthority.brand` before authoring the pack template | Product |
| 5 | Correct workspace `CLAUDE.md` §5: `au-immigration.json` is **2.4.0** on disk, the table says 2.3.0 | Jonas |
