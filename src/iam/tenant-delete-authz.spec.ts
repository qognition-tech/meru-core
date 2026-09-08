import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { PolicyGuard } from './guards/policy.guard';
import { VerticalPolicyService } from '../core/verticals/vertical-policy.service';
import { TenantProvisioningController } from './tenant-provisioning.controller';

/**
 * `DELETE /tenants/:id` (ADR 0009 §2.1) is a platform-wide, irreversible-
 * looking action and must be platform_admin only — the same gate every
 * other God View mutation on this controller (`provision`, `suspend`,
 * `resume`) already carries.
 *
 * Runs the REAL `Reflector` against the REAL
 * `TenantProvisioningController.prototype.remove`, matching the pattern in
 * `operator-entitlements-authz.spec.ts` and its siblings.
 */
describe('DELETE /tenants/:id — soft-delete is platform_admin only', () => {
  function contextFor(user: unknown) {
    return {
      getHandler: () => TenantProvisioningController.prototype.remove,
      getClass: () => TenantProvisioningController,
      switchToHttp: () => ({
        getRequest: () => ({ user, ip: '203.0.113.15' }),
      }),
    } as any;
  }

  function buildGuard() {
    const verticalPolicyService = {
      getPolicy: jest.fn(),
    } as unknown as VerticalPolicyService;
    const dataSource = { query: jest.fn() } as unknown as DataSource;
    return new PolicyGuard(new Reflector(), verticalPolicyService, dataSource);
  }

  it('refuses a client-only token', async () => {
    await expect(
      buildGuard().canActivate(
        contextFor({ id: 'client-a', roles: ['client'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses staff', async () => {
    await expect(
      buildGuard().canActivate(
        contextFor({ id: 'staff-1', roles: ['staff'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses firm_admin — a firm cannot delete its own tenant through this route', async () => {
    await expect(
      buildGuard().canActivate(
        contextFor({ id: 'admin-1', roles: ['firm_admin'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows platform_admin', async () => {
    await expect(
      buildGuard().canActivate(
        contextFor({ id: 'op-1', roles: ['platform_admin'] }),
      ),
    ).resolves.toBe(true);
  });
});
