import { WorkflowEngineService } from './workflow.service';
import { PlatformRole } from '../iam/enums/platform-role.enum';

/**
 * Regression tests for the transition permission gate.
 *
 * **The bug these exist for:** `checkPermissions` read only
 * `permissions.users`, so any transition carrying `permissions.roles` with an
 * empty `users` list returned `false` for every caller — including
 * `firm_admin` and `platform_admin`. `PackWorkflowService` materialises
 * exactly that shape (`{ roles: [step.assignedRole] }`, never `users`), and
 * the AU immigration pack sets `assignedRole` on all 14 steps of
 * `wf_visa_matter`. Clicking "Materialise all" in Settings → Workflows would
 * therefore have frozen every matter in that tenant permanently, with no error
 * anyone could read.
 *
 * Nothing caught it because no test exercised a role-bearing permission — the
 * only shapes covered were "no constraint" and "named user".
 *
 * `checkPermissions` is private and touches only `this.logger`, so these bind
 * the prototype rather than construct the service and its full repository
 * graph. That is deliberate: the unit under test is a pure decision function,
 * and standing up TypeORM to reach it would test the wiring instead.
 */
describe('WorkflowEngineService.checkPermissions', () => {
  const warn = jest.fn();
  const svc = Object.create(WorkflowEngineService.prototype) as Record<
    string,
    (...args: unknown[]) => boolean
  > & { logger: { warn: jest.Mock } };
  svc.logger = { warn };

  const check = (
    permissions: { roles?: string[]; users?: string[] },
    userId: string,
    userRoles: string[] = [],
  ): boolean =>
    (svc as unknown as {
      checkPermissions: (
        p: { roles?: string[]; users?: string[] },
        u: string,
        r: string[],
      ) => boolean;
    }).checkPermissions(permissions, userId, userRoles);

  beforeEach(() => warn.mockClear());

  it('allows when the transition carries no constraint at all', () => {
    expect(check({}, 'u1')).toBe(true);
    expect(check({ roles: [], users: [] }, 'u1')).toBe(true);
  });

  it('allows a user named explicitly in users[]', () => {
    expect(check({ users: ['u1', 'u2'] }, 'u1')).toBe(true);
  });

  it('refuses a user not named in users[] when users[] is the only constraint', () => {
    expect(check({ users: ['u2'] }, 'u1')).toBe(false);
  });

  it('allows an actor who holds one of the required roles', () => {
    expect(
      check({ roles: [PlatformRole.FIRM_ADMIN] }, 'u1', [
        PlatformRole.FIRM_ADMIN,
      ]),
    ).toBe(true);
  });

  it('refuses an actor who holds none of the required PlatformRoles', () => {
    // Evaluable and genuinely unmet — a real denial, not an unimplemented rule.
    expect(
      check({ roles: [PlatformRole.FIRM_ADMIN] }, 'u1', [PlatformRole.CLIENT]),
    ).toBe(false);
  });

  /**
   * The regression that matters. If this ever goes red as `false`, the
   * "Materialise all" outage is back: every pack-materialised transition
   * would refuse every user in the tenant.
   */
  it('does NOT lock out staff when the required role is a pack role with no carrier on User', () => {
    const packShape = { roles: ['migration_agent'] }; // exactly what PackWorkflowService writes

    expect(check(packShape, 'u1', [PlatformRole.FIRM_ADMIN])).toBe(true);
    expect(check(packShape, 'u1', [PlatformRole.STAFF])).toBe(true);
    expect(check(packShape, 'u1', [PlatformRole.PLATFORM_ADMIN])).toBe(true);
  });

  it('warns when it defers, so an authoring gap is visible rather than silent', () => {
    check({ roles: ['case_coordinator'] }, 'u1', [PlatformRole.STAFF]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('case_coordinator');
  });

  it('covers every assignedRole the AU immigration pack actually ships', () => {
    // Sourced from packages/config-packs/countries/au-immigration.json.
    // If a new practice role is added to a pack and the identity model still
    // cannot carry it, this must keep passing or matters freeze on materialise.
    for (const role of ['migration_agent', 'case_coordinator', 'client_portal']) {
      expect(check({ roles: [role] }, 'u1', [PlatformRole.FIRM_ADMIN])).toBe(
        true,
      );
    }
  });

  it('still refuses when a real PlatformRole is required alongside an unevaluable one', () => {
    // Mixed requirement: at least one role IS evaluable, so the rule is
    // implemented and an actor failing it is a genuine denial. This is the
    // boundary that stops the deferral branch from swallowing real gates.
    expect(
      check({ roles: ['migration_agent', PlatformRole.FIRM_ADMIN] }, 'u1', [
        PlatformRole.CLIENT,
      ]),
    ).toBe(false);
  });
});
