import { PlatformRole } from '../iam/enums/platform-role.enum';
import { TenantContext } from '../core/tenancy/tenant-context';

/**
 * Who is asking, reduced to the two facts an authorisation decision needs.
 *
 * Deliberately not `UserPayload`: services must not depend on the HTTP request
 * shape, and a job or a sweep that legitimately acts on a user's behalf can
 * construct one of these without faking a request.
 */
export interface Actor {
  id: string;
  roles: string[];
  /**
   * The caller's own email, when there is a caller.
   *
   * `own` scope needs it because an applicant is not the *assignee* of their
   * case — staff are — so identity-by-user-id cannot answer "is this record
   * mine". Records carry `subjectEmail` for exactly this comparison. Optional
   * so `SYSTEM_ACTOR` and any call site that predates it still compile; an
   * absent email simply never matches, which fails closed.
   */
  email?: string;
}

/**
 * The roles that work inside a tenant on its behalf.
 *
 * `platform_admin` is NOT here, and that is the point — see `isGodContext`.
 */
const TENANT_STAFF_ROLES: readonly string[] = [
  PlatformRole.FIRM_ADMIN,
  PlatformRole.STAFF,
];

/**
 * True when this unit of work is executing inside `TenancyService.runAsGod`.
 *
 * That wrapper writes a `CRITICAL` audit entry *before* the work and rethrows
 * if the audit write fails, so "we are in a god context" is the same statement
 * as "this access has been recorded". Operator reach into a tenant's records is
 * granted here and nowhere else: a bare `platform_admin` role on a token is a
 * claim about who someone is, not a record that they looked.
 */
export function isGodContext(): boolean {
  return TenantContext.getBypass()?.kind === 'god';
}

/** `firm_admin` or `staff` — the roles that work a tenant's whole caseload. */
export function isTenantStaff(roles: readonly string[] = []): boolean {
  return roles.some((r) => TENANT_STAFF_ROLES.includes(r));
}

/**
 * A `client` and nothing else: an applicant or a counterparty, never staff.
 *
 * A user holding both `client` and `staff` is staff — the wider role wins, or a
 * staff member with a client login for their own matter would lose their
 * caseload.
 */
export function isClientOnly(roles: readonly string[] = []): boolean {
  return roles.includes(PlatformRole.CLIENT) && !isTenantStaff(roles);
}

/**
 * How far inside one tenant a caller may see.
 *
 * RLS isolates tenants, not users inside a tenant, so this is the *only* thing
 * standing between one applicant and another's passport scan. It has to live in
 * a service, never a controller: `/crm/entities`, `/payments` and
 * `/communications/threads` each shipped this check on the controller or not at
 * all, and each time a later caller reached the service without it.
 *
 * - `god`    — inside `runAsGod`; already audited, unrestricted.
 * - `tenant` — `firm_admin` / `staff`; everything RLS lets the connection see.
 * - `own`    — everyone else, including a bare `platform_admin` token: their own
 *              records only. A platform operator who needs more takes the god
 *              path, which writes the audit entry that makes the reach legal.
 */
export type AccessScope = 'god' | 'tenant' | 'own';

export function scopeOf(actor: Actor): AccessScope {
  if (isGodContext()) return 'god';
  if (isTenantStaff(actor.roles)) return 'tenant';
  return 'own';
}

/**
 * The caller when no user is asking.
 *
 * Some work inside a tenant genuinely has no user behind it — the AI service
 * assembling context for a prompt, a sweep, a scheduled job. Those callers are
 * already confined by the `tenantId` they pass and by RLS on the connection;
 * what they lack is a *person* to scope to, and inventing one would be a lie.
 *
 * It carries `firm_admin` because tenant-wide is the correct reach for work the
 * tenant itself initiated, and because the alternative — leaving `roles` empty —
 * resolves to `own` scope against a user id of `system`, which matches nothing
 * and would silently return zero rows rather than failing.
 *
 * Two rules, and they are the reason this is a named export rather than an
 * inline object literal:
 *
 *  1. **Never derive it from request input.** It is a constant. A route that
 *     reaches this value because a header said so is an authorisation bypass.
 *  2. **Never use it to serve a user.** If a human is waiting on the response,
 *     the real `Actor` is available — pass that. `grep SYSTEM_ACTOR` should
 *     only ever find internal, non-user-facing call sites.
 */
export const SYSTEM_ACTOR: Actor = {
  id: 'system',
  roles: [PlatformRole.FIRM_ADMIN],
};
