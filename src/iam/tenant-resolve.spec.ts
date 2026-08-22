import { TenantProvisioningService } from './tenant-provisioning.service';

/**
 * `resolveByHost` is the only unauthenticated read of `tenants` besides the
 * slug check, so what it returns — and does not — is the contract.
 */
describe('TenantProvisioningService.resolveByHost', () => {
  const findOne = jest.fn();
  const getOne = jest.fn();
  const qb = {
    where: jest.fn(() => qb),
    getOne,
  };
  const tenantRepo = { findOne, createQueryBuilder: () => qb };
  const configService = { get: (k: string) => (k === 'BASE_DOMAIN' ? 'govx.com' : undefined) };

  const make = () =>
    new TenantProvisioningService(
      tenantRepo as never,
      undefined as never,
      undefined as never,
      undefined as never,
      configService as never,
      undefined as never,
    );

  const acme = {
    slug: 'acme',
    name: 'Acme Bank',
    vertical: 'grc',
    logoUrl: null,
    plan: 'enterprise',
    settings: {
      branding: { colors: { primary: '#123456' }, customDomain: 'grc.acme.ae' },
      limits: { users: 5 },
    },
  };

  beforeEach(() => {
    findOne.mockReset();
    getOne.mockReset();
  });

  it('resolves <slug>.<BASE_DOMAIN> by slug and returns public fields only', async () => {
    findOne.mockResolvedValue(acme);
    const out = await make().resolveByHost('ACME.govx.com:443');
    expect(findOne).toHaveBeenCalledWith({ where: { slug: 'acme' } });
    expect(out).toEqual({
      slug: 'acme',
      name: 'Acme Bank',
      vertical: 'grc',
      logoUrl: null,
      branding: { colors: { primary: '#123456' } },
      matchedBy: 'subdomain',
    });
    // Never leak plan, limits or the rest of settings to an anonymous caller.
    expect(out).not.toHaveProperty('plan');
    expect(out).not.toHaveProperty('settings');
  });

  it('falls back to customDomain for any other host', async () => {
    getOne.mockResolvedValue(acme);
    const out = await make().resolveByHost('grc.acme.ae');
    expect(findOne).not.toHaveBeenCalled();
    expect(out?.matchedBy).toBe('custom_domain');
  });

  it('never treats a reserved subdomain as a tenant', async () => {
    getOne.mockResolvedValue(null);
    const out = await make().resolveByHost('app.govx.com');
    expect(findOne).not.toHaveBeenCalled();
    expect(out).toBeNull();
  });

  it('returns null, not a throw, for an unknown host', async () => {
    getOne.mockResolvedValue(null);
    await expect(make().resolveByHost('nobody.example')).resolves.toBeNull();
  });
});
