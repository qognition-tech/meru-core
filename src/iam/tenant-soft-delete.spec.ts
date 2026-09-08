import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { Not } from 'typeorm';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenantStatus } from './entities/tenant.entity';
import { MeruErrorCode } from '../common/types';

/**
 * `TenantProvisioningService.softDeleteTenant` (ADR 0009 §2.1) — soft-delete
 * only, no hard purge, "type the slug to confirm", and the slug release that
 * makes a deleted tenant's name reusable.
 */
describe('TenantProvisioningService.softDeleteTenant', () => {
  const findOne = jest.fn();
  const save = jest.fn();
  const tenantRepo = { findOne, save };

  const make = () =>
    new TenantProvisioningService(
      tenantRepo as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

  const activeTenant = {
    id: '12345678-aaaa-bbbb-cccc-000000000001',
    slug: 'acme-immigration',
    status: TenantStatus.ACTIVE,
  };

  beforeEach(() => {
    findOne.mockReset();
    save.mockReset();
    save.mockImplementation((t) => Promise.resolve(t));
  });

  it('throws BadRequestException when the tenant does not exist, matching the existing "Tenant not found" convention', async () => {
    findOne.mockResolvedValue(null);

    await expect(
      make().softDeleteTenant('missing', 'whatever'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400s when confirmSlug does not match the current slug', async () => {
    findOne.mockResolvedValue({ ...activeTenant });

    await expect(
      make().softDeleteTenant(activeTenant.id, 'wrong-slug'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });

  it('409s with MER-TENANT-0008 when the tenant is already deleted — checked BEFORE confirmSlug, since a repeat call can never match the already-rewritten slug', async () => {
    findOne.mockResolvedValue({
      ...activeTenant,
      status: TenantStatus.DELETED,
      slug: 'acme-immigration--deleted--12345678',
    });

    // Note: confirmSlug passed here is the ORIGINAL slug an operator would
    // reasonably type, not the internal rewritten one — and it must still
    // report "already deleted", not "confirmation mismatch".
    const attempt = make().softDeleteTenant(activeTenant.id, 'acme-immigration');

    await expect(attempt).rejects.toBeInstanceOf(HttpException);
    await expect(attempt.catch((e) => e)).resolves.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: expect.objectContaining({
        code: MeruErrorCode.TENANT_ALREADY_DELETED,
      }),
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('soft-deletes, sets deletedAt, and releases the slug for reuse', async () => {
    findOne.mockResolvedValue({ ...activeTenant });

    const result = await make().softDeleteTenant(
      activeTenant.id,
      activeTenant.slug,
    );

    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0][0];
    expect(saved.status).toBe(TenantStatus.DELETED);
    expect(saved.deletedAt).toBeInstanceOf(Date);
    expect(saved.slug).toBe(
      `acme-immigration--deleted--${activeTenant.id.slice(0, 8)}`,
    );
    expect(result.releasedSlug).toBe(saved.slug);
    expect(result.status).toBe(TenantStatus.DELETED);
  });
});

describe('TenantProvisioningService.listAllTenants — deleted-tenant filtering', () => {
  const find = jest.fn().mockResolvedValue([]);
  const tenantRepo = { find };
  const userRepo = {
    createQueryBuilder: () => ({
      select: () => ({ addSelect: () => ({ groupBy: () => ({ getRawMany: async () => [] }) }) }),
    }),
  };

  const make = () =>
    new TenantProvisioningService(
      tenantRepo as never,
      userRepo as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

  beforeEach(() => find.mockClear());

  it('excludes deleted tenants by default', async () => {
    await make().listAllTenants();
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: Not(TenantStatus.DELETED) },
      }),
    );
  });

  it('includes deleted tenants when includeDeleted=true', async () => {
    await make().listAllTenants(true);
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });
});

describe('TenantProvisioningService.getPlatformStats — deleted-tenant filtering', () => {
  const find = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(0);
  const tenantRepo = { find };
  const userRepo = { count };

  const make = () =>
    new TenantProvisioningService(
      tenantRepo as never,
      userRepo as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

  it('always excludes deleted tenants — no override', async () => {
    await make().getPlatformStats();
    expect(find).toHaveBeenCalledWith({
      where: { status: Not(TenantStatus.DELETED) },
    });
  });
});

describe('TenantProvisioningService.setTenantStatus — agrees with soft-delete being terminal', () => {
  const findOne = jest.fn();
  const save = jest.fn();
  const tenantRepo = { findOne, save };

  const make = () =>
    new TenantProvisioningService(
      tenantRepo as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

  beforeEach(() => {
    findOne.mockReset();
    save.mockReset();
  });

  // This is the route actually reachable at PATCH /tenants/:id/resume —
  // confirmed by grep against tenant-provisioning.controller.ts. If this
  // refuses nothing, a soft-deleted tenant can be silently resurrected.
  it('refuses to reactivate (ACTIVE) a deleted tenant — resume must not resurrect', async () => {
    findOne.mockResolvedValue({ id: 't1', status: TenantStatus.DELETED });

    await expect(
      make().setTenantStatus('t1', TenantStatus.ACTIVE),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses to suspend a deleted tenant too', async () => {
    findOne.mockResolvedValue({ id: 't1', status: TenantStatus.DELETED });

    await expect(
      make().setTenantStatus('t1', TenantStatus.SUSPENDED),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });

  it('still allows the ordinary suspend/resume transitions on a non-deleted tenant', async () => {
    findOne.mockResolvedValue({ id: 't1', status: TenantStatus.ACTIVE });
    save.mockImplementation((t) => Promise.resolve(t));

    const result = await make().setTenantStatus('t1', TenantStatus.SUSPENDED);
    expect(result.status).toBe(TenantStatus.SUSPENDED);
    expect(save).toHaveBeenCalled();
  });
});
