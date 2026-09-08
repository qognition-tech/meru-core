# 0005 — Communications thread scoping: ratify what shipped, close what did not

**Status:** Proposed — 2026-09-05. Not merged. Requires `quality` (Owen) review, and `secops`
(Anton) review given `definition-of-done.md`'s "any change touching data access" gate — this
ADR both ratifies an existing control and adds a new one (audit).

**Scope:** the user-scoping contract for `/communications/*`, why the ImmiStack client
messages page still refuses to wire it, and the audit and staff/admin visibility gaps that
remain even though the read/send scoping itself is already correct.

---

## 1. Context — the finding that reframes the whole task

**The client-scoping bug the task brief describes does not exist in the code today.**
Workspace `CLAUDE.md` §8 lists `/communications/threads` among three routes "where a client
read other clients' message bodies in production" — but that is dated prose, not the current
state. Read directly:

- `CommunicationsController.clientScope` (`src/notifications/communications.controller.ts:55-67`)
  derives a `client`-role caller's scope from **`req.user.email`** — the validated JWT claim,
  never a caller-supplied parameter — and passes it as `counterparty` into every method.
- `ThreadService.listThreads` and `.getThread` both accept `options.counterparty` and, when set,
  either filter the SQL (`thread.service.ts:172-180`) or 404 on any other thread
  (`assertCounterparty`, `:130-135`) — **404, not 403**, deliberately: "a 403 on someone else's
  thread key confirms that the thread exists... which... tells the caller who else the firm is
  corresponding with" (`:124-129`).
- `ThreadService.send`'s `asCounterparty` parameter (`:294-361`) forces a client's outbound
  address to be their own; `to`/`threadKey` are ignored entirely for a client caller
  (`:298-299`), so a client cannot address a message into a thread with a different
  counterparty than their own.
- The comment at `communications.controller.ts:53` states this explicitly: *"Same shape of
  check as `PaymentsController.clientScope`, third resource to need it"* — i.e. this was
  built as the fix for exactly the gap workspace `CLAUDE.md` §8 names, following the same
  precedent already applied to `/payments`.

**The stale artifact is the frontend, not the backend.** ImmiStack's
`app/client/messages/page.tsx:7-29` carries a comment dated to when `GET
/communications/threads` "shipped on 2026-08-11 but is TENANT-scoped, not user-scoped" —
**true on 2026-08-11, false today.** The page deliberately renders a "not switched on yet"
placeholder rather than wire to what it believed was still a tenant-wide leak.

**Why this ADR exists anyway.** Two reasons:

1. **The correct behaviour, having shipped by fix rather than by design, was never written
   down as a decision** — no ADR states the contract, so the frontend's stale caution has
   nothing to check itself against, and the workspace doc (§8) still lists the bug as live.
   This ADR is that record, so the next reader does not re-litigate whether it is safe to wire.
2. **Two real gaps remain** even though scoping is correct: **no audit trail** on message
   sends (F1 below), and **no distinction between an internal note and an external message**
   at the core level (F2 below) — the task's request for "staff→client and staff→admin
   messaging semantics" is not fully answered by the existing 2-party thread model.

### 1.1 F1 — thread sends write no `audit_logs` entry

`ThreadService.send` (`thread.service.ts:294-361`) records the sender in
`metadata.customData.sentByUserId` (`:346-349`) and logs to the application logger
(`:357-359`) — **neither is `audit_logs`.** `grep -n "AuditService\|auditService" src/notifications/thread.service.ts
src/notifications/communications.controller.ts` returns zero matches. This is the same shape
of gap ADR 0008 found on `CrmService.update` (F4 there): a regulated correspondence record with
no entry in the append-only, hash-chained audit trail workspace `CLAUDE.md` §7.7 requires for
"every state-changing action." A firm's record of what it told a client is, today, the
`notifications` table alone — durable, but not the audited record a dispute (ImmiStack
`CLAUDE.md` §4.7's evidence pack) is built to assemble from.

### 1.2 F2 — no core distinction between "internal note" and "message to the client"

The core has two separate mechanisms that happen to serve this distinction today, but nothing
states that they are the boundary:

- `POST /crm/entities/:id/comments` (`src/crm/comment.service.ts`) — internal file notes,
  never delivered externally, referenced in ADR 0008 D2's dismissal design and flagged there as
  `[UNVERIFIED: whether CommentService writes an audit_logs entry]`.
- `/communications/threads` (`ThreadService`) — external correspondence, one thread per
  `channel:counterparty`, delivered (or recorded-pending) via `NotificationDispatchService`.

**Nothing prevents a staff member from pasting client-sensitive internal analysis into a
comment believing it is private, nor from drafting what they think is an internal note as a
thread reply by mistake** — the two are different controllers with different DTOs, so a
mis-click is a wrong-endpoint call, not a wrong-visibility flag on a shared one. That is
actually the safer shape (see D2), but it has never been stated as the reason, so a future
"let's unify comments and messages" proposal would be reinventing the leak these two staying
separate prevents.

### 1.3 What "staff→admin" means here, precisely

There is no `admin`-vs-`staff` internal messaging concept in core beyond the four
`PlatformRole` values (`platform_admin, firm_admin, staff, client` —
`src/iam/enums/platform-role.enum.ts:20-25`). ImmiStack's richer role table (manager, agent,
paralegal, partner — `immistack/CLAUDE.md` §2) is Layer-4 UI/pack vocabulary, not a core
concept, per the 80/20 rule (workspace `CLAUDE.md` §7.1). So "staff→admin messaging" in core
terms is: **an internal comment visible to every `staff`+ role in the tenant, never to
`client`** — which `CommentService` already is, by construction (it has no counterparty
concept at all, and RLS scopes it to the tenant like every other CRM row). This ADR does not
add a new "admin-only" visibility tier inside comments; that would be vertical/role-table
vocabulary (which roles above `staff` see which notes) and belongs in a pack or a later ADR
if a real need emerges (see §5).

---

## 2. Decisions

### D1 — ratify the existing contract; correct the stale documentation and wire the frontend

**Decision.** The contract, stated so it can be cited instead of re-derived:

> A `client`-role token may list, read, reply into and mark-read **only** the thread whose
> counterparty is that user's own account email (`req.user.email`), enforced in
> `ThreadService` — not the controller — so no future caller of the service can bypass it by
> skipping a controller-level check. Any other thread key returns `404`. A `staff`+ role sees
> every thread in the tenant (RLS-scoped, as normal).

**Actions, not code changes to `ThreadService`/`CommunicationsController` — those are already
correct:**

1. Correct `immistack/app/client/messages/page.tsx`'s stale comment and wire it to
   `GET /communications/threads` / `POST /communications/messages` / `POST
   /communications/threads/:threadKey/messages`, exactly as documented at
   `communications.controller.ts:69-177`.
2. Update workspace `CLAUDE.md` §8's list to stop naming `/communications/threads` as a live
   instance of the cross-client leak — it is the **fixed** precedent now, alongside
   `/payments`, not a third open instance. Jonas to make this edit in the same commit as this
   ADR merges, per workspace §15 ("update the relevant doc in the same commit").
3. **Cross-tenant test case, per `definition-of-done.md`'s "any change touching data access"
   gate**, even though the code is not changing: a `client`-role integration test asserting a
   second client's thread key 404s, and a staff test asserting the full tenant list is
   returned. If this test does not already exist, it is the one piece of "implementation" this
   ADR requires, and it is a test, not a feature.

### D2 — comments and threads stay two mechanisms; this ADR states why, so it is not re-merged later

**Decision.** `POST /crm/entities/:id/comments` (internal) and `/communications/threads`
(external) remain separate resources, separate DTOs, separate controllers.

**Why not a single "message" resource with a `visibility: internal | external` flag.** A
shared resource means a single toggle stands between a staff note and a message the client
reads — exactly the failure mode ADR 0008's D3 rejected for the card-authority DTO ("an open
bag on it is precisely where a PAN would eventually be written, by exactly the well-meaning
code path §4.3 exists to prevent," applied here to visibility instead of PII). A staff member
who fat-fingers `visibility: external` on what they meant as an internal note has just sent a
client a message that was never meant to leave the firm; a staff member who calls the wrong
**endpoint** has to actively choose the wrong tool, which is a much rarer mistake. Two
resources make the external boundary structural, not a checkbox.

### D3 — thread sends and reads-of-others'-threads-by-staff are audited

**Decision.** `ThreadService.send` gains an `AuditService.logEvent` call, `action:
AuditAction.CREATE`, `entityType: 'communication_thread'`, `entityId: threadKey`, `severity:
AuditSeverity.INFO` for an ordinary send. This closes F1 and matches the pattern ADR 0008's D6
uses for `entityTypes[].fields[].audited` — a state-changing write on a regulated
correspondence record gets an audit row, full stop, not conditionally.

**Contract addition, no new route:**

```jsonc
// audit_logs.context for a thread send
{
  "threadKey": "email:jane@example.com",
  "channel": "email",
  "direction": "outbound",
  "senderId": "<users.id>"
}
```

**Why `INFO` and not `WARNING`/`CRITICAL`.** An ordinary send is routine business activity, the
same severity tier as any other `CREATE` audit entry elsewhere in the codebase — this is not a
god-mode or cross-tenant access, which is what `CRITICAL` is reserved for
(`TenancyService.runAsGod`, workspace §7.7). Reserving `CRITICAL` for its actual meaning is
what keeps a CRITICAL-severity audit query useful as an incident signal rather than noise.

**Why the audit write happens inside `ThreadService.send`, not the controller.** Same reasoning
as the scoping check itself (§1's D1): a future caller of `ThreadService` directly (a job, a
migration script) inherits the audit write for free. An audit call bolted onto the controller
is exactly the kind of check that a second call site forgets.

### D4 — no new "admin-only" internal visibility tier in core

**Decision.** This ADR does **not** add a role finer than `staff` vs `client` to either
comments or threads. If a real product need emerges for "this note is visible to `firm_admin`
only, not `staff`", that is Layer-4 vocabulary (which roles see what) and belongs in a pack's
`roles[]`/`entityTypes[]` extension, evaluated the same way ADR 0008's D6 `lockedWhen` pattern
works — a generic, pack-declared visibility predicate core evaluates without knowing what a
"paralegal" is. Not built here because no concrete need has been named yet (see §5).

---

## 3. API contract, for reference (no route shapes change — only the audit side-effect and the test requirement)

```
GET  /communications/threads              staff: whole tenant · client: own thread only (404 elsewhere)
GET  /communications/threads/:threadKey   staff: any thread in tenant · client: own only, else 404
POST /communications/messages             start a thread; client's `asCounterparty` forces their own address
POST /communications/threads/:threadKey/messages   reply into a thread; same client confinement
POST /communications/threads/:threadKey/read       mark inbound messages read; same confinement
```

Envelope, error codes: unchanged, standard `{data, meta, error}` (workspace `CLAUDE.md` §11).
No new `MER-*` code is introduced — the 404-on-someone-else's-thread behaviour already exists
and uses the standard `RES` family.

---

## 4. Options rejected

| Option | Why rejected |
|---|---|
| Merge comments and threads into one "message" resource with a visibility flag | Turns a structural boundary (two endpoints) into a single flag a staff member can get wrong (D2) |
| Add a fine-grained internal visibility tier now, speculatively | No concrete requirement named yet; premature Layer-4 vocabulary in core would violate the 80/20 rule (D4) |
| Audit at `WARNING` severity for every send, to make sends easy to find in a filtered query | Reserves a severity tier that should mean "needs a human's attention" for routine traffic, defeating its purpose (D3) |
| Leave the frontend page un-wired until a separate frontend-only ticket addresses it | The backend fix has been sitting unused since before this ADR; ratifying it now is what unblocks Mira without a second research pass |

---

## 5. Consequences

1. **ImmiStack's client messaging goes from a placeholder to a live feature** the moment D1's
   frontend wiring ships — this is a genuine product capability landing, not just a doc fix,
   and should be treated with the same care as any new client-facing surface (five states,
   `no-slop.md`, per `definition-of-done.md`'s UI section).
2. **Every thread send after D3 ships writes one more audit row.** At firm-scale correspondence
   volume this is a real, if modest, increase in `audit_logs` write volume — the same
   trade-off ADR 0008 §9 named for `CrmService.update` and left as a wider, separate question.
   This ADR accepts the cost for threads specifically because correspondence is exactly what an
   evidence pack (ImmiStack `CLAUDE.md` §4.7) needs to reconstruct.
3. **The workspace doc correction (D1 action 2) changes a widely-cited "three known instances"
   count to two currently-open plus one fixed** — anyone who has memorised "CRM, payments,
   communications" as the three should re-read workspace §8 after this merges.

---

## 6. What would make these decisions wrong later

| Trigger | Which decision it invalidates | What to do |
|---|---|---|
| A concrete product need for role-scoped internal visibility (e.g. a note only `firm_admin` should see) is named | D4 | Design a pack-declared visibility predicate on comments, evaluated the same generic way as ADR 0008's `lockedWhen` — do not hardcode a role check in `CommentService` |
| Audit write volume from D3 becomes a measurable cost concern | D3's unconditional audit | Consider sampling or batching audit writes for `INFO`-severity thread sends specifically — but only after measuring, not speculatively |
| A vertical needs a message visible to more than two parties (e.g. cc'ing a co-applicant) | The `channel:counterparty` two-party thread key itself | This is a larger redesign of `ThreadService`'s keying and is out of scope for this ADR — flag it as its own ADR rather than patching the key format |
| `CommentService` is confirmed to write no audit entry (the `[UNVERIFIED]` item ADR 0008 left open) | D2's assumption that comments are already a safe, separate mechanism | Comments need the same D3 treatment threads are getting here — file as a follow-up, do not assume audit parity |

---

## 7. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| D1 frontend wiring | Revert the ImmiStack page to its placeholder | None — no backend state changes |
| D1 workspace doc correction | Revert the doc edit | None |
| D3 audit write in `ThreadService.send` | Revert the commit; sends continue unaudited as today | Audit rows already written are append-only (workspace §7.7) and are not removed — they are simply correct records of sends that happened while the code was live |

**Rollback verification:** re-run the ImmiStack sweep (33/33 baseline, workspace §7.2) after
wiring the client messages page, and confirm a `client`-role integration test still 404s on
another client's thread key before and after — the one behavioural guarantee this ADR must not
regress.

---

## 8. Open items for the implementers

| # | Item | Owner |
|---|---|---|
| 1 | Write the cross-tenant/cross-client integration test named in D1 action 3, if it does not already exist — check `thread.service.spec.ts` first | Owen |
| 2 | Wire `immistack/app/client/messages/page.tsx` to the live routes; five-state UI (empty/loading/error/populated/overflowing) per `definition-of-done.md` | Mira |
| 3 | Correct workspace `CLAUDE.md` §8's "three known instances" framing in the same commit as this ADR merges | Jonas |
| 4 | Add the `AuditService.logEvent` call to `ThreadService.send`, confirm it does not fire for a `PENDING` row that later fails dispatch differently than one that succeeds (i.e. audit the *send attempt*, not the delivery outcome) | Luke |
| 5 | Resolve ADR 0008's open `[UNVERIFIED]` on `CommentService` audit writes — this ADR's D2 assumes an answer it does not yet have | Luke |
