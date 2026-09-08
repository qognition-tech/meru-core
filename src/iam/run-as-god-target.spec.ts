import { TenancyService } from '../core/tenancy/tenancy.service';
import { OperatorController } from './operator.controller';
import { PlatformController } from './platform.controller';
import { TenantProvisioningController } from './tenant-provisioning.controller';
import { ConfigPackController } from '../tenant/controllers/config-pack.controller';
import { TenantStatus } from './entities/tenant.entity';
import { PlatformRole } from './enums/platform-role.enum';
import type { AuthenticatedRequest } from '../common/types';

/**
 * `TenancyService.runAsGod(actorId, targetTenantId, reason, fn)` writes a
 * CRITICAL audit row under `targetTenantId` before `fn` runs. All ten call
 * sites in this codebase passed `req.user.tenantId` — the OPERATOR's own
 * tenant — instead of the tenant the work actually touched. The starkest
 * instance: `OperatorController.impersonate` filed "operator impersonated one
 * of your users" under the operator's tenant, so the firm whose user was
 * impersonated could never find that record in their own audit log — the one
 * entry that most needs to be visible to them.
 *
 * This suite asserts the audit row's `tenantId` equals the tenant the work
 * touched, for every call site that has one, and pins the deliberate
 * exceptions (platform-wide reads with no single target; tenant
 * provisioning, whose target does not exist until after the work runs) so a
 * future edit does not "fix" those into an invented id.
 */
describe('runAsGod call sites — the audit row is filed under the tenant touched, not the caller\'s', () => {
  const OPERATOR_TENANT = 'platform-tenant';
  const TARGET_TENANT = 'target-tenant';

  const operatorReq = {
    user: {
      id: 'operator-1',
      email: 'op@meru.internal',
      tenantId: OPERATOR_TENANT,
      roles: [PlatformRole.PLATFORM_ADMIN],
    },
  } as AuthenticatedRequest;

  function buildTenancyService() {
    const logEvent = jest.fn().mockResolvedValue({});
    const tenancyService = new TenancyService({ logEvent } as any);
    return { tenancyService, logEvent };
  }

  function auditedTenantId(logEvent: jest.Mock): string {
    expect(logEvent).toHaveBeenCalledTimes(1);
    return logEvent.mock.calls[0][0].tenantId;
  }

  describe('OperatorController', () => {
    function buildController(tenancyService: TenancyService) {
      return new OperatorController(
        {
          getEntitlements: jest.fn().mockResolvedValue({ modules: [] }),
        } as any,
        { get: jest.fn().mockResolvedValue({}) } as any,
        { listForTenant: jest.fn().mockResolvedValue([]) } as any,
        tenancyService,
        {
          issueImpersonationToken: jest.fn().mockResolvedValue({ accessToken: 'x' }),
        } as any,
      );
    }

    it('entitlements (via forTenant) audits the target tenant', async () => {
      const { tenancyService, logEvent } = buildTenancyService();
      const controller = buildController(tenancyService);

      await controller.entitlements(operatorReq, TARGET_TENANT);

      expect(auditedTenantId(logEvent)).toBe(TARGET_TENANT);
    });

    it('branding (via forTenant) audits the target tenant', async () => {
      const { tenancyService, logEvent } = buildTenancyService();
      const controller = buildController(tenancyService);

      await controller.branding(operatorReq, TARGET_TENANT);

      expect(auditedTenantId(logEvent)).toBe(TARGET_TENANT);
    });

    it('impersonate audits the tenant being impersonated into, not the operator\'s tenant', async () => {
      const { tenancyService, logEvent } = buildTenancyService();
      const controller = buildController(tenancyService);

      await controller.impersonate(operatorReq, TARGET_TENANT, {
        reason: 'Ticket MER-1234 — investigating a customer report',
      } as any);

      expect(auditedTenantId(logEvent)).toBe(TARGET_TENANT);
      expect(auditedTenantId(logEvent)).not.toBe(OPERATOR_TENANT);
    });
  });

  describe('TenantProvisioningController', () => {
    function buildController(tenancyService: TenancyService) {
      return new TenantProvisioningController(
        {
          setTenantStatus: jest.fn().mockResolvedValue({}),
          getTenantStats: jest.fn().mockResolvedValue({}),
          listAllTenants: jest.fn().mockResolvedValue([]),
          provisionTenant: jest.fn().mockResolvedValue({}),
        } as any,
        tenancyService,
        { inviteUser: jest.fn().mockResolvedValue({}) } as any,
      );
    }

    it('suspend audits the tenant being suspended', async () => {
      const { tenancyService, logEvent } = buildTenancyService();
      const controller = buildController(tenancyService);

      await controller.suspend(operatorReq, TARGET_TENANT);

      expect(auditedTenantId(logEvent)).toBe(TARGET_TENANT);
    });

    it('resume audits the tenant being resumed', async () => {
      const { tenancyService, logEvent } = buildTenancyService();
      const controller = buildController(tenancyService);

      await controller.resume(operatorReq, TARGET_TENANT);

      expect(auditedTenantId(logEvent)).toBe(TARGET_TENANT);
    });

    it('getStats (cross-tenant path) audits the tenant being read, not the operator\'s', async () => {
      const { tenancyService, logEvent } = buildTenancyService();
      const controller = buildController(tenancyService);

      await controller.getStats(operatorReq, TARGET_TENANT);

      expect(auditedTenantId(logEvent)).toBe(TARGET_TENANT);
    });

    it('getStats reading the caller\'s own tenant never goes through runAsGod at all', async () => {
      const { tenancyService, logEvent } = buildTenancyService();
      const controller = buildController(tenancyService);

      await controller.getStats(operatorReq, OPERATOR_TENANT);

      expect(logEvent).not.toHaveBeenCalled();
    });

    it('deliberate exception: listTenants has no single target, stays under the operator\'s tenant', async () => {
      const { tenancyService, logEvent } = buildTenancyService();
      const controller = buildController(tenancyService);

      await controller.listTenants(operatorReq);

      expect(auditedTenantId(logEvent)).toBe(OPERATOR_TENANT);
    });

    it('deliberate exception: provision has no target until the work creates one, stays under the operator\'s tenant', async () => {
      const { tenancyService, logEvent } = buildTenancyService();
      const controller = buildController(tenancyService);

      await controller.provision(operatorReq, {
        slug: 'new-firm',
      } as any);

      expect(auditedTenantId(logEvent)).toBe(OPERATOR_TENANT);
    });
  });

  describe('PlatformController — both routes are deliberate exceptions (platform-wide, no single target)', () => {
    function buildController(tenancyService: TenancyService) {
      return new PlatformController(
        { getPlatformStats: jest.fn().mockResolvedValue({}) } as any,
        tenancyService,
        { reload: jest.fn().mockResolvedValue({}) } as any,
      );
    }

    it('stats stays under the operator\'s tenant', async () => {
      const { tenancyService, logEvent } = buildTenancyService();
      const controller = buildController(tenancyService);

      await controller.stats(operatorReq);

      expect(auditedTenantId(logEvent)).toBe(OPERATOR_TENANT);
    });

    it('reloadConfigPacks stays under the operator\'s tenant', async () => {
      const { tenancyService, logEvent } = buildTenancyService();
      const controller = buildController(tenancyService);

      await controller.reloadConfigPacks(operatorReq);

      expect(auditedTenantId(logEvent)).toBe(OPERATOR_TENANT);
    });
  });

  describe('ConfigPackController (via forTenant)', () => {
    function buildController(tenancyService: TenancyService) {
      return new ConfigPackController(
        { getTenantPins: jest.fn().mockResolvedValue([]) } as any,
        tenancyService,
        {} as any,
      );
    }

    it('getTenantPins audits the target tenant, not the operator\'s', async () => {
      const { tenancyService, logEvent } = buildTenancyService();
      const controller = buildController(tenancyService);

      await controller.getTenantPins(operatorReq, TARGET_TENANT);

      expect(auditedTenantId(logEvent)).toBe(TARGET_TENANT);
    });
  });
});
