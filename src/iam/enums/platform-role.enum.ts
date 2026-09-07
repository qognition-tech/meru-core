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

/**
 * Whether a caller holding `actorRoles` may grant `targetRole` to someone
 * else — including to themselves, via a self-update.
 *
 * A caller may only grant a role at or below their own most-privileged
 * position in `ROLE_PRECEDENCE`. This is the fix for a real defect:
 * `POST /iam/users/invite` and `PATCH /iam/users/:id` are both reachable by
 * `firm_admin` (tenant-scoped), but `InviteUserDto.role` and
 * `UpdateUserDto.role` validate only `@IsEnum(PlatformRole)`, which includes
 * `platform_admin` — nothing stopped a `firm_admin` from inviting a
 * `platform_admin`, or PATCHing their own user row to become one. Once the
 * JWT carries `platform_admin` it passes every `@Roles(PLATFORM_ADMIN)` route
 * — God View, tenant provisioning, `TenancyService.runAsGod` cross-tenant
 * reads — none of which RLS defends against, because `runAsGod` bypasses
 * tenancy by design. `platform_admin` must never be grantable from a
 * tenant-scoped route; only a caller who already holds it may hand it out.
 *
 * Fails closed on both sides: an actor holding no ranked role, or a target
 * role that is not in `ROLE_PRECEDENCE` at all, is refused rather than
 * treated as the least-privileged case.
 */
export function canGrantRole(
  actorRoles: readonly string[],
  targetRole: string,
): boolean {
  const targetRank = ROLE_PRECEDENCE.indexOf(targetRole);
  if (targetRank === -1) return false;

  const actorRank = ROLE_PRECEDENCE.findIndex((r) => actorRoles.includes(r));
  if (actorRank === -1) return false;

  // Lower index = more privileged, so "at or below the caller's own rank"
  // is "the target's rank is numerically >= the caller's".
  return actorRank <= targetRank;
}
