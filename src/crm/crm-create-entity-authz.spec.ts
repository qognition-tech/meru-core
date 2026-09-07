import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { VerticalPolicyService } from '../core/verticals/vertical-policy.service';
import { CrmController } from './crm.controller';

/**
 * `POST /crm/entities` carried `@UseGuards(AuthGuard('jwt'), PolicyGuard)`
 * but no `@Roles`, and `crmService.createEntity` took no actor at all.
 * `CreateEntityDto` accepts `subjectEmail` — the field that now confines a
 * `client`-role caller to a record on every OTHER CRM route — and
 * `assignedTo`, a staff user id. An unrestricted `client` token could plant
 * a fabricated case into another applicant's portal by naming their email,
 * or assign work to an arbitrary staff id. `POST /payments` gates the
 * equivalent hole ("a client cannot invoice themselves") the same way, with
 * `@Roles(PLATFORM_ADMIN, FIRM_ADMIN, STAFF)`.
 *
 * This runs the REAL `Reflector` against the REAL
 * `CrmController.prototype.createEntity`, not a stand-in method or a
 * hand-written metadata object — the point is to prove `@Roles` is actually
 * attached to this route handler, not just present somewhere in the file.
 * `PolicyGuard`'s own metadata read (`getAllAndOverride('roles', …)`) is the
 * same mechanism `POST /payments` already relies on, exercised the same way
 * `policy.guard.spec.ts` exercises the guard itself.
 */
describe('POST /crm/entities — creation is staff-gated', () => {
  function contextFor(user: unknown) {
    return {
      getHandler: () => CrmController.prototype.createEntity,
      getClass: () => CrmController,
      switchToHttp: () => ({
        getRequest: () => ({ user, ip: '203.0.113.10' }),
      }),
    } as any;
  }

  function buildGuard() {
    const reflector = new Reflector();
    const verticalPolicyService = {
      getPolicy: jest.fn(),
    } as unknown as VerticalPolicyService;
    // No tenantId on any actor below, so `resolveVertical` short-circuits
    // before this is ever touched (see PolicyGuard.resolveVertical) — the
    // point of this suite is the ROLE gate, not the vertical policy engine.
    const dataSource = { query: jest.fn() } as unknown as DataSource;
    return new PolicyGuard(reflector, verticalPolicyService, dataSource);
  }

  it('refuses a client-only token', async () => {
    const guard = buildGuard();
    await expect(
      guard.canActivate(contextFor({ id: 'client-a', roles: ['client'] })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a client who also holds no other role, explicitly, not just by falling through', async () => {
    const guard = buildGuard();
    await expect(
      guard.canActivate(contextFor({ id: 'client-b', roles: ['client'] })),
    ).rejects.toThrow('Insufficient Role Privileges');
  });

  it('allows staff', async () => {
    const guard = buildGuard();
    await expect(
      guard.canActivate(contextFor({ id: 'staff-1', roles: ['staff'] })),
    ).resolves.toBe(true);
  });

  it('allows firm_admin', async () => {
    const guard = buildGuard();
    await expect(
      guard.canActivate(contextFor({ id: 'admin-1', roles: ['firm_admin'] })),
    ).resolves.toBe(true);
  });

  it('allows platform_admin', async () => {
    const guard = buildGuard();
    await expect(
      guard.canActivate(
        contextFor({ id: 'op-1', roles: ['platform_admin'] }),
      ),
    ).resolves.toBe(true);
  });

  it('a client who also holds staff is staff, matching isTenantStaff elsewhere', async () => {
    const guard = buildGuard();
    await expect(
      guard.canActivate(
        contextFor({ id: 'dual-1', roles: ['client', 'staff'] }),
      ),
    ).resolves.toBe(true);
  });
});
