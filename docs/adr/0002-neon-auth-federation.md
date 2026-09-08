# 0002 — Neon Auth federation (post-pilot)

**Status:** Proposed — 2026-09-05. Not merged. Requires review by `secops` (Anton) before any
implementation begins — this ADR touches auth, per this repo's `definition-of-done.md`
("Any change to auth, tenancy, the data model, or a third-party integration" requires
security-auditor review) — and by `quality` (Owen) before anything merges.

**Scope:** whether and how to federate identity to Neon Auth after ImmiStack's first pilot,
per the operator's standing decision ("launch on the current IAM, migrate to Neon Auth after
the first pilot"). This ADR does not implement the migration; it decides the shape so Luke is
not improvising auth on the day it is scheduled.

---

## 1. Context

### 1.1 What "Neon Auth" is today — verified externally, not assumed

The name has drifted under the operator during 2026. As of this ADR:

- Neon's current product is **"Managed Better Auth"** — built on **Better Auth 1.4.18**, not
  Stack Auth — and it is explicitly marked **Beta**
  ([Neon Auth overview](https://neon.com/docs/auth/overview)).
- The **prior** Stack-Auth-based "Neon Auth" still runs for projects already on it, with a
  migration path off it, per the same page. So "Neon Auth" now names two different products
  depending on when a project was created — this ADR assumes the **current, Beta, Better-Auth
  product**, because that is what a new integration would be provisioned against today, and
  says so because it is the fact most likely to be wrong when someone next reads this.
- Users, sessions and OAuth configuration are stored **in the tenant's own Neon Postgres
  database**, under a `neon_auth` schema — not a separate managed store
  ([backend integration](https://neon.com/docs/neon-auth/concepts/backend-integration),
  [authentication flow](https://neon.com/docs/auth/authentication-flow)).
- Sign-in issues an HttpOnly session cookie **plus** a short-lived JWT (**15-minute expiry, no
  refresh token** — the client re-calls `authClient.token()`), verified against a JWKS endpoint
  at `<NEON_AUTH_URL>/.well-known/jwks.json` using **EdDSA (Ed25519)**
  ([JWT plugin](https://neon.com/docs/auth/guides/plugins/jwt)).
- Standard claims only: `sub`, `email`, `name`, `image`, `role`, `banned`, `iat`, `exp`, `iss`,
  `aud`. **"Custom claims are not supported at this time"** — same source.
- Identity providers documented: email/password, OAuth (Google out of the box), "more Better
  Auth integrations… added" per roadmap. **SAML/SSO is not mentioned anywhere in the pages
  fetched for this ADR.** `[UNVERIFIED: whether Managed Better Auth supports SAML today —
  absence from the docs fetched is not proof of absence from the product; re-check before
  committing to a pilot date]`.
- No webhook or user-sync mechanism for an external database is documented on the pages
  fetched. `[UNVERIFIED: webhook/sync support — not found in the fetched docs, not confirmed
  absent]`.

**Why this matters before anything else in this ADR.** Meru's own IAM already has SAML
(`src/iam/services/saml.service.ts`) and the operator's golden rule elsewhere assumes Neon
Auth is a drop-in replacement for identity. **It is not, today** — it is a Beta product with no
documented SAML, no documented custom claims, and no documented webhook. A federation design
built on it must not silently drop SAML for any pilot tenant that uses it, and must not assume
a capability the vendor has not shipped.

### 1.2 What Meru's own IAM does today (the thing being federated, not replaced)

- **`@nestjs/jwt` + `passport-jwt`.** `JwtStrategy.validate` (`src/iam/strategies/jwt.strategy.ts:41-60`)
  returns `{id, email, tenantId, roles, sessionId, impersonatedBy}` from a self-issued token
  carrying `sub, email, tenantId, roles, role, sid, imp?` (`src/iam/iam.service.ts:1111-1136`,
  `:1182-1192`).
- **Sessions are Meru's own table**, not a vendor concept: `Session` rows carry
  `refreshTokenHash`, `tokenHash` (`iam.service.ts:908-932`), and revocation is a single
  `UPDATE … WHERE revokedAt IS NULL` (`:238-245`) — atomic, so a stolen refresh token cannot be
  replayed after rotation. `JwtStrategy.assertSessionLive` (`:70-101`) caches a
  live/revoked verdict for 60s (`REVOCATION_TTL_MS`, `:25`) so revocation bites within a minute
  without a DB read on every request.
- **Tenant binding is independent of the auth mechanism.** `TenantAlsMiddleware` →
  `TenantBindingInterceptor` → `applyRlsToDataSource` sets `app.current_tenant_id` on the
  connection from `payload.tenantId` on the validated user (workspace `CLAUDE.md` §8). Nothing
  about this reads a login provider. **This is the property that must not move.**
- **Tenant membership is one row, not a join table.** `User.tenantId` is a plain column
  (`src/iam/entities/user.entity.ts:35`), globally-unique `email`
  (`iam.service.ts:713-717` — deliberately global, because `validateUser` resolves login by
  email alone with no tenant hint). **There is no `tenant_memberships` table** — grep for
  `TenantMembership`/`tenant_memberships` across `src/` returns zero matches. One user, one
  tenant, today. A person who legitimately works at two tenants (an affiliate, a contractor)
  holds two separate `User` rows with the same email is impossible — the email uniqueness is
  global — so today they need a second email address. **This is worth stating because it
  bounds what a federation design must NOT invent**: adding a real membership model is a
  separate, larger ADR, and this one takes single-tenant-per-user as given.
- **Impersonation is a bespoke, deliberately narrow token** (`issueImpersonationToken`,
  `iam.service.ts:1158-1204`): no refresh token, no session row, 15 minutes, an `imp` claim
  naming the operator. It is issued by Meru's own `JwtService`, not by a login provider, and
  must keep being issued that way — see D4.
- **Invites are Meru's own token, not the provider's.** `inviteUser` issues a single-use,
  SHA-256-hashed `AuthToken` of type `INVITE` (`iam.service.ts:718-791`), redeemed at
  `resetPassword` (`:1036-1092`), which also **revokes every session** on redemption. See
  ADR 0006 for what happens when mail cannot deliver it.
- **Three frontends store only a refresh token**, in an HttpOnly cookie scoped to
  `/api/session`, per app (`meru-core-fe/CLAUDE.md` §5): `gx_rt`, `is_rt`, `md_rt`. The access
  token is memory-only. `PUT /api/session` (`meru-core-fe/immistack/app/api/session/route.ts:18-31`)
  is the one place a raw token crosses into browser JS, for the single write.

### 1.3 The two things a "federation" can mean, and which one this ADR picks

**Option A — full replacement.** Neon Auth issues the session; Meru's `Session`/`AuthToken`
tables and `JwtStrategy` are retired; RLS binds off a Neon Auth claim.

**Option B — federation, not replacement.** Neon Auth (or any external IdP) authenticates the
*person*; Meru continues to issue its own session, its own access token, and remains the
source of truth for tenant membership and roles. This is what "federation" means in every other
system with a tenancy model richer than the IdP's own (which is exactly Meru's situation, given
§1.2's single-tenant-per-user row and the RLS binding above).

**Decision: Option B.** See D1.

---

## 2. Decisions

### D1 — Neon Auth authenticates; Meru continues to issue the session

**Decision.** Neon Auth becomes a **login method**, not a session authority. Flow:

1. Frontend completes sign-in against Neon Auth's client SDK (email/password or OAuth).
2. Frontend sends Neon Auth's JWT to a new backend route, `POST /auth/federated/neon`.
3. Backend verifies the JWT against Neon Auth's JWKS (cached, see D2), extracts `sub` and
   `email`.
4. Backend resolves (or provisions — see D3) the Meru `User` row by email, exactly as
   `validateUser` does today for password login (`iam.service.ts:83-99`), then calls the
   **existing** `issueSession` (`:1111-1136`) unchanged.
5. Response shape is byte-identical to `POST /auth/login`'s success response — `{access_token,
   refresh_token, expires_in, token_type, tenant_id, user}` — so the three frontends' existing
   `AuthBootstrap` / session-cookie handling need no new code path, only a new entry point.

**Why not Option A.** Three reasons, in order of weight:

- **RLS binds on `payload.tenantId`, which Neon Auth's JWT cannot carry** — it has no concept
  of Meru's tenants and, per §1.1, does not support custom claims today. Binding RLS to a
  claim the IdP does not carry is not a rounding error; it is the whole tenancy model.
- **Impersonation must remain a Meru-issued, no-refresh-token, 15-minute grant** (§1.2). No
  external IdP should ever be asked to mint a token that lets a Meru operator act as someone
  in another tenant — that capability must never leave this codebase's audit trail.
- **Neon Auth is Beta with no documented SAML.** Full replacement would mean every SAML-using
  tenant loses SSO the day the migration ships, silently, unless this ADR explicitly carries
  it forward — see D5.

**What does NOT change, stated so it is not re-litigated:**

- `TenantAlsMiddleware` → `TenantBindingInterceptor` → `applyRlsToDataSource` (workspace
  `CLAUDE.md` §8) — untouched. RLS keeps binding off the Meru-issued token's `tenantId` claim,
  regardless of how the person authenticated.
- `Session` / `AuthToken` tables, `JwtStrategy`, revocation, `issueImpersonationToken` — all
  unchanged code paths.
- The three frontends' cookie/session handling (`meru-core-fe/CLAUDE.md` §5) — unchanged;
  `POST /auth/federated/neon` is a new *source* for the same response shape they already
  consume from `POST /auth/login`.
- `User.tenantId` as a single column, one tenant per user — unchanged. Neon Auth is not asked
  to solve multi-tenant membership; Meru already does not solve it either (§1.2), and this ADR
  does not expand scope to build it.

### D2 — JWKS verification is cached, not re-fetched per request

**Decision.** A new `NeonAuthStrategy` (parallel to `JwtStrategy`, not a modification of it)
fetches `<NEON_AUTH_URL>/.well-known/jwks.json` via `jose`'s `createRemoteJWKSet`, which caches
by `kid` and only re-fetches on an unknown key id. Verify `iss`/`aud` equal the configured Neon
Auth origin (per the docs cited in §1.1), reject otherwise.

**Why not verify via Neon's REST API per request.** The docs describe both a fast local JWKS
verification and a slower REST round-trip
([backend integration](https://neon.com/docs/neon-auth/concepts/backend-integration)). A
Vercel function with a 60s ceiling (workspace `CLAUDE.md` §10) and `DB pool max: 1` should not
add a second external HTTP round-trip to every login. Local JWKS verification is the same
trust model TLS already relies on and costs one cached fetch per key rotation, not per request.

### D3 — first-login provisioning is explicit, not automatic, and email-matched

**Decision.** `POST /auth/federated/neon` does **not** create a `User` row on an unrecognised
email. It returns `404 MER-AUTH-0004 "No Meru account for this address"` with a `helpUrl`
pointing at the invite flow. A Meru account must already exist — via `POST /iam/users/invite`
or `POST /tenants` (ADR 0006 covers the invite-link recovery gap) — before Neon Auth can sign
someone into it.

**Why not auto-provision.** Auto-creating a tenant-scoped user from an arbitrary verified email
would let anyone who can authenticate against Neon Auth's own sign-up flow — which is public,
by design, for Neon Auth's other customers — obtain a Meru account with **no tenant assigned
and no role**, which is either a dangling user or a security question about what tenant/role a
walk-up federated login should default to. Meru's tenancy model has no answer to that question
today, and this ADR is not the place to invent one. Provisioning stays invite-first.

**Matching key is email**, same as every existing bootstrap lookup (`iam.service.ts:83-99`,
`:991-993`). `users.email` is globally unique (§1.2), so this is unambiguous. A user whose Neon
Auth email differs from their Meru account email (e.g. they signed up to Neon Auth with a
personal address) simply gets the 404 above and must use password login or be re-invited.

### D4 — impersonation is untouched and must stay untouched

**Decision.** `issueImpersonationToken` is not reachable through Neon Auth in any form, now or
later. It remains a `platform_admin`-only, Meru-`JwtService`-signed grant behind
`TenancyService.runAsGod` (`iam.service.ts:1158-1204`). Nothing in this ADR proposes a way for
an operator's Neon Auth session to mint one directly; the existing `POST
/tenants/:id/impersonate`-shaped route (wherever it lives today) keeps requiring a live Meru
session first.

### D5 — SAML is carried forward explicitly, not assumed superseded

**Decision.** `src/iam/services/saml.service.ts` and its route(s) are **not removed or
deprecated** by this ADR. Per §1.1, Managed Better Auth's documented provider set does not
include SAML/SSO. Any tenant on SAML today stays on Meru's own SAML path indefinitely, or until
a **separate** ADR verifies Neon Auth has shipped SAML and designs the cutover. Do not let a
sprint quietly fold "migrate to Neon Auth" into "and therefore drop our SAML code" — those are
different projects and only one of them is decided here.

### D6 — the pilot boundary is a feature flag, not a big-bang cutover

**Decision.** `POST /auth/federated/neon` ships disabled by a tenant-level setting
(`tenants.settings.authProvider: 'local' | 'neon'`, additive, default `'local'` — same additive
pattern as the entitlement vocabulary in workspace `CLAUDE.md` §7.2's worked example). The
pilot tenant is flipped to `'neon'` after `POST /tenants/signup`'s existing password path is
proven unaffected by the new route's mere existence (see rollback verification). Every other
tenant's login is byte-identical to today, because `POST /auth/login` is untouched code.

---

## 3. Options rejected

| Option | Why rejected |
|---|---|
| **Full replacement (Option A)** | RLS binding, impersonation and SAML all break or need reinvention on day one, against a Beta vendor product with no documented custom claims (§1.1, §1.3). |
| **Custom JWT claims carrying `tenantId`/`roles` inside the Neon Auth token** | Not supported today (§1.1, cited). Revisit if the vendor ships it — see §7. |
| **Auto-provision a `User` on first federated login** | No answer for which tenant/role a walk-up account gets; invite-first is the existing, audited path (D3). |
| **Verify tokens via Neon's REST API per request instead of JWKS** | An extra external round-trip on every request inside a 60s serverless ceiling with a 1-connection DB pool (workspace `CLAUDE.md` §10); local JWKS verification is standard practice and cheaper (D2). |
| **Big-bang cutover for all tenants at once** | No rollback path if Neon Auth's Beta status bites in production; a per-tenant flag (D6) makes the blast radius one pilot tenant. |

---

## 4. Consequences

1. **Two login routes exist during the pilot** (`POST /auth/login`, `POST
   /auth/federated/neon`), and both must keep working. Anton should review whether rate
   limiting (ADR 0004) covers the new route identically to `/auth/login` — an unthrottled
   second door into the same account space is the obvious miss.
2. **The 15-minute Neon Auth JWT, no-refresh-token model (§1.1) is irrelevant to session
   length** — Meru's own 30-day refresh token / 1-hour access token (`iam.service.ts:57`,
   `:1133`) takes over the moment step 4 in D1 runs. The frontend never holds onto the Neon
   Auth token past the exchange call.
3. **SAML and Neon Auth are now two separate identity paths a tenant can be on**, and a tenant
   must be on exactly one (D5, D6). `tenants.settings.authProvider` needs a third value if SAML
   is modelled the same way — out of scope here; today SAML tenants simply never set
   `authProvider: 'neon'`.
4. **Neon Auth's Beta status is Meru's risk, not just the vendor's.** A breaking change to the
   JWKS shape or claim set breaks `POST /auth/federated/neon` in production for however many
   tenants have been flipped to it. D6's per-tenant flag is what limits this to the pilot.
5. **This ADR adds one new external dependency to the auth path** for flagged tenants: a JWKS
   fetch to a Neon-operated origin. If that origin is unreachable, login for those tenants
   fails; local password login (`POST /auth/login`) is unaffected because it does not call out.

---

## 5. What would make these decisions wrong later

| Trigger | Which decision it invalidates | What to do |
|---|---|---|
| Neon ships custom JWT claims | D1's "cannot carry tenantId" reasoning | Re-evaluate whether `tenantId`/`roles` can ride the Neon Auth token directly; D1's session-issuance step may shrink, but RLS still must bind off *something* verified server-side, never a client-asserted claim |
| Neon ships SAML/SSO support | D5 | Only then open the SAML-cutover ADR. Do not pre-empt it here |
| Managed Better Auth exits Beta with a published stability/SLA commitment | The risk framing in §4.4 | Re-assess whether the per-tenant flag (D6) is still needed, or whether a wider rollout is safe |
| A second tenant needs to add a federated user who already has a Meru account under a different tenant | D3's single-tenant-per-user assumption | This is the `tenant_memberships` gap named in §1.2 — needs its own ADR, not a patch here |
| The pilot tenant reports SSO friction Neon Auth was meant to solve, and asks to add a second IdP (Okta, Entra) | D1's provider-agnostic exchange route | `POST /auth/federated/neon` should be generalised to `POST /auth/federated/:provider` before a second IdP is bolted on as a copy-paste route |

---

## 6. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| `POST /auth/federated/neon` route + `NeonAuthStrategy` | Delete the route and set every tenant's `authProvider` back to `'local'` (or leave — the route 404s if no tenant references it). Revert the commit | None — the route issues ordinary `Session`/refresh-token rows via the existing path, indistinguishable from a password login |
| `tenants.settings.authProvider` flag | Remove the key from `settings` (it is an open bag, per workspace `CLAUDE.md` §7.5's `verticalAttributes` precedent extended to tenant settings) — no migration needed, it was never a column | None |
| Pilot tenant flipped to `'neon'` | Flip back to `'local'`. Users who only ever signed in via Neon Auth still have their original Meru password (if one was ever set) or must go through `POST /auth/forgot-password` | Sessions issued while on `'neon'` are ordinary `Session` rows; revoking them is `IamService.logout(userId)`, unchanged |

**Rollback verification:** confirm `POST /auth/login` and `POST /auth/refresh` behaviour is
byte-identical before and after this ships, for a tenant that never touches
`authProvider: 'neon'` — the strongest evidence this is additive rather than a rewrite.

---

## 7. Open items for the implementers

| # | Item | Owner |
|---|---|---|
| 1 | `[UNVERIFIED]` Confirm current SAML/SSO support (or its absence) on Neon's Managed Better Auth directly with Neon, not from docs alone, before setting a pilot date | Product, with Jonas |
| 2 | `[UNVERIFIED]` Confirm whether a webhook or sync mechanism exists for external-database user provisioning — would simplify D3 if it does | Luke |
| 3 | Design `MER-AUTH-0004`'s exact `helpUrl` and message copy pointed at the invite flow | Mira, with the ADR 0006 owner |
| 4 | Confirm rate limiting (ADR 0004) is applied to `POST /auth/federated/neon` identically to `/auth/login` before this reaches any tenant | Anton |
| 5 | Security review of the whole exchange flow, per `definition-of-done.md`'s "auth, tenancy, data model, third-party integration" gate | Anton |
