/**
 * The platform's four canonical roles.
 *
 * This is the *only* set of role strings that mean anything end-to-end: they
 * are what `IamService.resolvePrimaryRole` ranks, what the `role` JWT claim
 * carries, and what the portals' `UserRole` union accepts when picking a
 * portal and gating the /platform, /admin, /staff and /client prefixes.
 *
 * Guarding a route with any other string is a silent 403 for every user —
 * `PolicyGuard` does `requiredRoles.some(r => user.roles.includes(r))`, so an
 * unmatched role name is indistinguishable from a real denial. `@Roles('admin')`
 * did exactly that on `GET /auth/profile` and `POST /tenant/settings`: no user
 * has ever held `admin`, so both endpoints were unreachable rather than
 * protected. Always guard with a member of this enum.
 *
 * Vertical-specific role vocabularies (GovernanceX's COMPLIANCE_OFFICER,
 * ImmiStack's agent/support) are a Layer-4 concern and belong in a config
 * pack — never in core. See CLAUDE.md §6 and the 80/20 rule in §11.3.
 */
export enum PlatformRole {
  /** Meru staff. Cross-tenant reach, God View. */
  PLATFORM_ADMIN = 'platform_admin',
  /** Owns a single tenant: billing, settings, the user directory. */
  FIRM_ADMIN = 'firm_admin',
  /** Works cases inside one tenant. */
  STAFF = 'staff',
  /** External end-user of a tenant. Sees only their own records. */
  CLIENT = 'client',
}


/**
 * Every role, in descending privilege. `resolvePrimaryRole` walks this to
 * collapse a user's role list into the single role the portals switch on.
 */
export const ROLE_PRECEDENCE: readonly string[] = [
  PlatformRole.PLATFORM_ADMIN,
  PlatformRole.FIRM_ADMIN,
  PlatformRole.STAFF,
  PlatformRole.CLIENT,
];
