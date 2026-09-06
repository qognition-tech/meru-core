# 0006 — Operator invite-link retrieval and regeneration

**Status:** Proposed — 2026-09-05. Not merged. Requires `quality` (Owen) review, and `secops`
(Anton) review — this ADR exposes a credential-equivalent secret through a new route, which is
squarely inside `definition-of-done.md`'s "auth, tenancy" gate.

**Scope:** a `platform_admin` route to hand an operator a usable invite link when Resend is
unset or delivery has failed, without ever emailing it from that route, with a CRITICAL audit
entry, per the operator's decision.

---

## 1. Context

### 1.1 What exists today

`IamService.inviteUser` (`src/iam/iam.service.ts:718-791`) creates the `User` row, then issues
a single-use token via the private `issueAuthToken` (`:952-978`): a random 32-byte
base64url token, **only its SHA-256 persisted** (`AuthToken.tokenHash`), 7-day expiry
(`INVITE_TTL_DAYS`, `:59`). It attempts delivery via `MailService.sendInvite`
(`:775-781`) and returns `{..., inviteSent: delivered}` — `delivered` is the honest signal
already in place; workspace `CLAUDE.md` §12 records that with `RESEND_API_KEY` unset, "invites
record and never arrive." `IamService.resendInvite` (`:803-841`) does the same for an
already-invited user, but **only** when `user.status === UserStatus.INVITED`
(`:815-819`) — it refuses on an already-active user, correctly, since re-issuing a
password-set link onto live credentials is exactly the takeover primitive this ADR must not
create either.

`TenantProvisioningService.provisionTenant` (`src/iam/tenant-provisioning.service.ts:374-466`)
— the "God UI creates a GovX/ImmiStack tenant" flow — calls the same `inviteUser` under the
hood (`:447-452`) for the tenant's first `firm_admin`, and surfaces the same `inviteSent`
boolean (`:463`).

**The operative fact that shapes this whole ADR: the plaintext token is never persisted.**
`issueAuthToken` returns `{token, expiresAt}` to its caller exactly once, at issuance
(`:952-978`); the database holds only `tokenHash`. **There is nothing to "retrieve."** Any
route named "retrieve the invite link" must, in truth, mint a **new** token and invalidate the
old one — which is exactly what `resendInvite` already does for the email path. This ADR's
real subject is: do that same regeneration, but hand the token back in an API response instead
of an email, to an operator who can be trusted to relay it by hand (Slack, a phone call) when
Resend cannot.

### 1.2 Why this needs its own route rather than reusing `resendInvite`

`resendInvite` always calls `MailService.sendInvite` (`:830-836`) — it has no "skip the email"
mode, and adding one as an optional flag on the existing method would let a bug or a
misconfigured client accidentally suppress emailing a real invite silently. A **separate**
route makes "this specific call never emails anything" the caller's explicit, auditable
choice, not a flag on a general-purpose method that mostly does the opposite.

### 1.3 Why this is a credential-equivalent secret, not a convenience feature

Redeeming the token sets the account's password (`IamService.resetPassword`,
`:1036-1092`) — whoever holds a live invite link for a `firm_admin` account can take it over.
This is the same class of secret as an API key or a session token, and the route that exposes
it must be treated with the same care: `platform_admin` only, audited at `CRITICAL`, and
**never** logged or returned anywhere the token itself could leak into a log line, an error
message, or a third party (workspace `CLAUDE.md` §7.7's constraint on `audit_logs` being
append-only makes this doubly true — a token accidentally written into an audit `context`
field cannot be scrubbed later).

---

## 2. Decisions

### D1 — a new `IamService` method: mint fresh, invalidate old, do not email

**Decision.** `IamService` gains a public method, `issueInviteLinkForOperator`, that reuses the
existing private `issueAuthToken` exactly as `resendInvite` does, but returns the raw token and
skips `mailService.sendInvite` entirely:

```ts
async issueInviteLinkForOperator(
  tenantId: string,
  userId: string,
): Promise<{ email: string; token: string; expiresAt: Date; status: UserStatus }> {
  const user = await this.userRepo.findOne({ where: { id: userId, tenantId } });
  if (!user) throw new NotFoundException('User not found');

  // Same restriction as resendInvite (:815-819) — an active user's credentials
  // must go through password reset, not a re-issued invite. The two share this
  // guard so they cannot silently diverge.
  if (user.status !== UserStatus.INVITED) {
    throw new BadRequestException(
      'That user has already accepted their invitation. Use password reset instead.',
    );
  }

  const { token, expiresAt } = await this.issueAuthToken(
    user, AuthTokenType.INVITE, this.INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  return { email: user.email, token, expiresAt, status: user.status };
}
```

**Why the same `status !== INVITED` guard as `resendInvite`.** Consistency is the point: an
operator route that could regenerate a "password set" link for an **active** user would be a
second, wider path to the exact takeover primitive `resendInvite` was already careful to close.
If an active user genuinely needs credential recovery, `POST /auth/forgot-password` is the
existing, correct path — self-service, emailed to the account's own address, not handed to an
operator to relay.

**Why this burns the previous token, same as every `issueAuthToken` call.** `issueAuthToken`
already marks any unused token of the same type as used before minting a new one
(`:961-964`) — unconditional, no new code needed. **This is the operational meaning of
"retrieve"** for this feature: the previous link, if one exists and was never emailed
successfully, is dead the moment this route is called. State this to operators plainly in the
route's description so nobody expects two live links to coexist.

### D2 — the route: `platform_admin`, `runAsGod`, CRITICAL audit, the token appears exactly once, in the response body

**Decision.**

```
POST /platform/tenants/:tenantId/users/:userId/invite-link
```

`platform_admin` only, wrapped in `TenancyService.runAsGod` exactly as
`PlatformController.reloadConfigPacks` already is (`src/iam/platform.controller.ts:59-90`) —
this is a cross-tenant operator action by construction (an operator acting on any tenant's
user), so it belongs on `PlatformController` alongside the other God-View routes, not on
`IamModule`'s tenant-scoped `users.controller.ts`.

```jsonc
// 200 response
{
  "data": {
    "email": "jane@firm.example",
    "url": "https://app.immistack.com/reset-password?token=<raw-token>",
    "expiresAt": "2026-09-12T00:00:00.000Z",
    "status": "invited"
  },
  "meta": { "requestId", "timestamp", "version": "v1" },
  "error": null
}
```

**The full `url`, not a bare token.** The three frontends' password-set page is
`/reset-password?token=…` (workspace `meru-core-fe/AGENTS.md` §8b item 5: "`/reset-password`
also carries tenant invite links, so it must be public"). Handing an operator a bare token
forces them to reconstruct the URL by hand, per-app, per-domain — a needless chance to send a
link to the wrong product's domain. The route resolves which of the three frontend origins to
use from the tenant's `vertical` (`immigration → app.immistack.com`, `grc → govx-app.vercel.app`),
same mapping `TenantsController`'s host-resolution route already encodes (workspace
`CLAUDE.md` §16, "No tenant-domain resolution" — FIXED).

**Audit — `CRITICAL`, before the token is minted, never carrying the token.**

```jsonc
// audit_logs.context, via runAsGod's own mechanism plus one additional entry
{
  "reason": "Operator retrieved invite link",
  "actorId": "<platform_admin users.id>",
  "targetUserId": "<invitee users.id>",
  "targetEmail": "jane@firm.example",
  "mode": "god"
  // NEVER: token, url — the constraint from §1.3
}
```

`runAsGod` already writes one `CRITICAL` entry for the cross-tenant access itself
(`TenancyService.runAsGod`, `src/core/tenancy/tenancy.service.ts:44-70`) — this route needs no
**second** audit call beyond what `runAsGod` already provides, because the entire operation
(find the user, mint the token) happens inside the wrapped callback and is exactly the
"access" `runAsGod` accounts for. The `context` payload above is what `runAsGod`'s `reason`
and the callback's own logging should carry — **the implementer must confirm neither the
token nor the constructed URL is interpolated into the `reason` string or any log line**, since
`reason` and `context` both land in the append-only `audit_logs` table.

**Error codes.**

| Status | Code | When |
|---|---|---|
| 404 | `MER-RES-0010` | No such user in that tenant |
| 400 | `MER-VAL-0014` | User status is not `invited` |
| 403 | — (existing `PolicyGuard`) | Caller is not `platform_admin` |

### D3 — resend semantics stay separate and unchanged; this route is the escape hatch, not the default path

**Decision.** `IamService.resendInvite` (email-based) remains the default way a `firm_admin`
recovers from a bounced or lost invite for their own tenant's users — it needs no
`platform_admin` escalation and already exists. **This ADR's route is for exactly the case
workspace `CLAUDE.md` §12 names: `RESEND_API_KEY` unset, so `resendInvite` faithfully reports
`inviteSent: false` and there is no delivery path at all** — the operator must relay the link
by some out-of-band channel until mail is configured. Once `RESEND_API_KEY` is set, the normal
`resendInvite` path (or the tenant's own `firm_admin` calling `POST
/iam/users/:id/resend-invite`) is the one to use again; this route does not become the default
just because it is more convenient for an operator to reach for.

**Why not fold this into `provisionTenant`'s response instead of a separate call.**
`provisionTenant` (`tenant-provisioning.service.ts:374-466`) already returns `inviteSent`
(`:463`); if it is `false`, the operator's very next action is exactly this route, one call
later, against the `firm_admin` user `provisionTenant` just created. Returning the raw token
directly from `provisionTenant` was considered and rejected: `provisionTenant`'s own audit
framing is "tenant created" (`INFO`-shaped, a normal provisioning action), and folding a
credential-equivalent secret into that response would put the token in a **wider** set of
response logs and integrations (anything that already consumes the provisioning response)
than the narrow, dedicated route this ADR defines. One route, one purpose, one blast radius.

---

## 3. Options rejected

| Option | Why rejected |
|---|---|
| Store the plaintext token (encrypted) so it can genuinely be "retrieved" rather than regenerated | Defeats the single-use design the rest of the credential-recovery mechanism relies on (`issueAuthToken`'s burn-before-issue pattern, `:961-964`); every other token in this system is hash-only, and this would be the one exception |
| Add a `skipEmail` flag to the existing `resendInvite` | A flag on a method whose entire purpose is "send the email" is one bad default away from silently not emailing a real invite (§1.2) |
| Return the token from `provisionTenant` directly when `inviteSent: false` | Widens the exposure surface to every existing consumer of that response; a dedicated route keeps the blast radius to whoever calls it deliberately (D3) |
| Allow this route for any user status, not just `invited` | Reopens the exact takeover primitive `resendInvite` already closed for active users (D1) |
| Skip the audit entry since `runAsGod` already logs the access | `runAsGod`'s entry is generic ("cross-tenant access"); the `context` fields this ADR specifies (`targetUserId`, `targetEmail`) are what make the entry useful for *this* specific action later, and costs nothing extra to include |

---

## 4. Consequences

1. **A `platform_admin` can now mint a live, password-setting link for any tenant's invited
   user, and see it in a response body.** This is a powerful capability handed to a role that
   already has god-mode read access — the marginal new risk is specifically that the secret is
   now visible in a response, not that the access itself is new (an operator with DB access
   could already forge a comparable outcome by other means, just not this cleanly).
2. **Every call burns the previous link.** An operator who calls this route "just to check" has
   invalidated whatever link was previously issued — including one the invitee might be about
   to click. This must be stated plainly in the route's `ApiOperation` description so it is not
   discovered by an invitee's support ticket.
3. **The token appears in the HTTP response and, transitively, in whatever channel the operator
   relays it through** (Slack, a support ticket) — this ADR controls what the API does, not
   what an operator does with the value afterward. That is a process control, not a code
   control, and should be named in the platform operator runbook Jonas maintains.

---

## 5. What would make these decisions wrong later

| Trigger | Which decision it invalidates | What to do |
|---|---|---|
| `RESEND_API_KEY` becomes reliably configured across all environments, including any future ones | D3's framing of this as "the escape hatch for when mail is unset" | Consider whether the route should be disabled (feature-flagged off) rather than merely unused, to shrink the standing attack surface once it is no longer needed day-to-day |
| An operator support tool (a ticketing integration) wants to call this route programmatically rather than a human relaying the link by hand | D2's assumption that the caller is a human relaying by out-of-band channel | Re-examine whether the response should instead trigger a scoped, logged relay (e.g. to a specific support inbox) rather than returning the raw token to any `platform_admin` caller |
| A second invite-bearing token type is added (e.g. a magic-link login) | D1's reuse of `issueAuthToken`/`AuthTokenType.INVITE` | Confirm the new type gets the same `status !== INVITED`-equivalent guard before any operator-retrieval route is extended to cover it |

---

## 6. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| `IamService.issueInviteLinkForOperator` | Revert the commit. No other code path calls this method | None — it only ever writes an `AuthToken` row, exactly like every existing invite/resend call |
| `POST /platform/tenants/:tenantId/users/:userId/invite-link` route | Remove the route from `PlatformController` | `AuditService` entries from past calls are append-only and remain (workspace §7.7) — correct, they are a true record that the route was used while live |

**Rollback verification:** confirm `resendInvite`'s existing behaviour (email path, `INVITED`
status guard) is unchanged by grepping for any shared code this ADR modified — it modifies
none; D1's method is additive and calls the same private `issueAuthToken` `resendInvite` also
calls, with no shared code path altered.

---

## 7. Open items for the implementers

| # | Item | Owner |
|---|---|---|
| 1 | Confirm the tenant→frontend-origin mapping used for constructing `url` matches the live `GET /tenants/resolve` logic exactly, so an operator is never handed a link to the wrong product's domain | Luke |
| 2 | Add this route's usage to the platform operator runbook, naming the out-of-band relay step as a process control, not a code control | Jonas |
| 3 | Confirm no logging middleware (request/response logging) captures the raw response body for this specific route — the token must not end up in an application log even though it is not in `audit_logs` | Anton |
| 4 | Security review of the whole route, per `definition-of-done.md`'s auth gate | Anton |
