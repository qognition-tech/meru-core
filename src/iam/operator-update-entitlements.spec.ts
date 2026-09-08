import { BadRequestException } from '@nestjs/common';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenantPlan } from './entities/tenant.entity';

/**
 * `TenantProvisioningService.updateEntitlementsAsOperator` (ADR 0009 §2.2) —
 * the one substantive difference from `updateOwnEntitlements` is that it does
 * NOT enforce the plan ceiling, and it must report the overage it created
 * rather than silently absorbing it.
 *
 * If the ceiling check from `updateOwnEntitlements` were copy-pasted into
 * this method instead of a fresh no-ceiling implementation, the first test
 * below ("grants a module outside the plan") would throw where it must
 * succeed — that is the failure this spec exists to catch.
 */
describe('TenantProvisioningService.updateEntitlementsAsOperator', () => {
  const findOne = jest.fn();
  const save = jest.fn();
  const tenantRepo = { findOne, save };
  // updateEntitlementsAsOperator returns through getEntitlements, which reads
  // `tenant_connectors` off `this.dataSource` directly (not a repo the
  // constructor injects) — stubbed empty, connectors are not this spec's
  // concern.
  const dataSource = {
    getRepository: () => ({ find: jest.fn().mockResolvedValue([]) }),
  };

  const make = () =>
    new TenantProvisioningService(
      tenantRepo as never,
      undefined as never,
      undefined as never,
      dataSource as never,
      undefined as never,
      undefined as never,
    );

  const freeTenant = {
    id: 'tenant-free-1',
    plan: TenantPlan.FREE,
    settings: {},
  };

  beforeEach(() => {
    findOne.mockReset();
    save.mockReset();
    save.mockImplementation((t) => Promise.resolve(t));
  });

  it('grants a module outside the plan — no ceiling, unlike updateOwnEntitlements', async () => {
    findOne.mockResolvedValue({ ...freeTenant });

    const result = await make().updateEntitlementsAsOperator(
      'tenant-free-1',
      ['sso', 'api_access'],
    );

    expect(save).toHaveBeenCalled();
    const saved = save.mock.calls[0][0];
    // FREE plan does not include sso/api_access — both are still written.
    expect(saved.settings.modules).toEqual(
      expect.arrayContaining(['sso', 'api_access']),
    );
    expect(result.overage.sort()).toEqual(['api_access', 'sso']);
  });

  it('reports no overage when every requested module is within the plan', async () => {
    findOne.mockResolvedValue({ ...freeTenant });

    const result = await make().updateEntitlementsAsOperator(
      'tenant-free-1',
      ['crm', 'documents'],
    );

    expect(result.overage).toEqual([]);
  });

  it('does not treat a country entry as overage', async () => {
    findOne.mockResolvedValue({ ...freeTenant });

    const result = await make().updateEntitlementsAsOperator(
      'tenant-free-1',
      ['country:AU'],
    );

    expect(result.overage).toEqual([]);
  });

  it('re-adds core modules unconditionally, same as updateOwnEntitlements', async () => {
    findOne.mockResolvedValue({ ...freeTenant });

    await make().updateEntitlementsAsOperator('tenant-free-1', []);

    const saved = save.mock.calls[0][0];
    expect(saved.settings.modules).toEqual(
      expect.arrayContaining([
        'crm',
        'cases',
        'tasks',
        'documents',
        'payments',
        'communications',
      ]),
    );
  });

  it('throws when the tenant does not exist', async () => {
    findOne.mockResolvedValue(null);

    await expect(
      make().updateEntitlementsAsOperator('missing', ['sso']),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('TenantProvisioningService.getPlanAllowance', () => {
  const findOne = jest.fn();
  const tenantRepo = { findOne };

  const make = () =>
    new TenantProvisioningService(
      tenantRepo as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

  beforeEach(() => findOne.mockReset());

  it('returns the FREE plan allowance — core modules only', async () => {
    findOne.mockResolvedValue({ id: 't1', plan: TenantPlan.FREE });
    const allowance = await make().getPlanAllowance('t1');
    expect(allowance).toEqual(
      expect.arrayContaining(['crm', 'cases', 'tasks', 'documents']),
    );
    expect(allowance).not.toContain('sso');
  });

  it('throws when the tenant does not exist', async () => {
    findOne.mockResolvedValue(null);
    await expect(make().getPlanAllowance('missing')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
