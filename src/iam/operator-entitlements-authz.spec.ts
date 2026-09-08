import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { PolicyGuard } from './guards/policy.guard';
import { VerticalPolicyService } from '../core/verticals/vertical-policy.service';
import { OperatorController } from './operator.controller';

/**
 * `PUT /tenants/:id/entitlements` (ADR 0009 §2.2) is gated with
 * `@Roles(PlatformRole.PLATFORM_ADMIN)` directly on the handler, unlike the
 * self-service `PUT /tenants/me/entitlements` which also allows `firm_admin`.
 * Getting this wrong either way is a real hole: too loose and any firm admin
 * grants their own tenant modules with no plan ceiling (the entire point of
 * §2.2 removing the ceiling); too tight (routed through `forTenant`, which
 * lets a caller act on their own tenant without `platform_admin`) and an
 * operator could self-grant via their own control-plane tenant id.
 *
 * Runs the REAL `Reflector` against the REAL
 * `OperatorController.prototype.updateEntitlements`, not a stand-in, so the
 * claim under test is that `@Roles` is attached to *this* handler — matching
 * `crm-create-entity-authz.spec.ts` / `import-authz.spec.ts`.
 */
describe('PUT /tenants/:id/entitlements — operator override is platform_admin only', () => {
  function contextFor(user: unknown) {
    return {
      getHandler: () => OperatorController.prototype.updateEntitlements,
      getClass: () => OperatorController,
      switchToHttp: () => ({
        getRequest: () => ({ user, ip: '203.0.113.12' }),
      }),
    } as any;
  }

  function buildGuard() {
    // No tenantId on any actor below, so `resolveVertical` short-circuits
    // before the policy engine is touched (see PolicyGuard.resolveVertical)
    // — this suite is about the ROLE gate, matching its two siblings above.
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

  it('refuses plain staff', async () => {
    await expect(
      buildGuard().canActivate(
        contextFor({ id: 'staff-1', roles: ['staff'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses firm_admin — unlike the self-service route, this one has no plan ceiling to protect against', async () => {
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
