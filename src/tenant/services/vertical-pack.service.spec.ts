import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { VerticalPackService } from './vertical-pack.service';
import { ConfigPack } from '../entities/config-pack.entity';
import { TenantConfigPin } from '../../iam/entities/tenant-config-pin.entity';
import { TenantContext } from '../../core/tenancy/tenant-context';

/**
 * The resolver is small, but two of its behaviours are load-bearing and were
 * previously reimplemented per feature: the version tiebreak, and treating a
 * missing section as absent rather than as an error.
 */
describe('VerticalPackService', () => {
  let service: VerticalPackService;
  const getOne = jest.fn();
  const findPins = jest.fn();
  const orderBy = jest.fn();
  const addOrderBy = jest.fn();

  /** A query builder that records the clauses it was given. */
  const makeQb = () => {
    const qb: Record<string, unknown> = {};
    for (const method of ['where', 'andWhere']) {
      qb[method] = jest.fn(() => qb);
    }
    qb.orderBy = jest.fn((...args: unknown[]) => {
      orderBy(...args);
      return qb;
    });
    qb.addOrderBy = jest.fn((...args: unknown[]) => {
      addOrderBy(...args);
      return qb;
    });
    qb.getOne = getOne;
    return qb;
  };

  beforeEach(async () => {
    getOne.mockReset();
    findPins.mockReset();
    findPins.mockResolvedValue([]);
    orderBy.mockReset();
    addOrderBy.mockReset();
    const moduleRef = await Test.createTestingModule({
      providers: [
        VerticalPackService,
        {
          provide: getRepositoryToken(ConfigPack),
          useValue: { createQueryBuilder: jest.fn(() => makeQb()) },
        },
        {
          provide: getRepositoryToken(TenantConfigPin),
          useValue: { find: findPins },
        },
      ],
    }).compile();
    service = moduleRef.get(VerticalPackService);
  });

  it('prefers the vertical base pack over any country overlay, then the highest version', async () => {
    getOne.mockResolvedValue({ code: 'grc', schema: {} });

    await service.forVertical('grc');

    // Both clauses are the assertion. Five packs answer to `vertical = 'grc'`
    // — the base plus four country overlays — so without the first clause the
    // database returns an arbitrary one, and a UAE bank silently gets
    // Bahrain's regulators. Without the second, an unpinned tenant can be
    // served last month's definition.
    expect(orderBy).toHaveBeenCalledWith(
      expect.stringContaining("country") as unknown as string,
      'DESC',
    );
    expect(addOrderBy).toHaveBeenCalledWith('p.version', 'DESC');
  });

  it('returns null rather than throwing when the vertical is unknown', async () => {
    // A tenant mid-onboarding legitimately has no vertical. Throwing here would
    // turn a normal state into a 500 in every caller.
    await expect(service.forVertical(null)).resolves.toBeNull();
    expect(getOne).not.toHaveBeenCalled();
  });

  it('returns null rather than throwing when no pack exists', async () => {
    getOne.mockResolvedValue(null);
    await expect(service.section('health', 'prompts')).resolves.toBeNull();
  });

  it('reads a named section out of the pack schema', async () => {
    getOne.mockResolvedValue({
      code: 'ae-banking',
      schema: { prompts: [{ key: 'a' }, { key: 'b' }] },
    });

    const section = await service.section<Array<{ key: string }>>(
      'banking',
      'prompts',
    );

    expect(section).toHaveLength(2);
  });

  it('distinguishes "no pack" from "pack with no such section"', async () => {
    getOne.mockResolvedValue({ code: 'ae-banking', schema: {} });

    const { pack, section } = await service.sectionWithPack(
      'banking',
      'messaging',
    );

    // Being able to name the pack is what makes the resulting error message
    // diagnosable: "ae-banking defines none" versus "nothing resolved".
    expect(pack?.code).toBe('ae-banking');
    expect(section).toBeNull();
  });

  it('collapses absent and empty array sections for list callers', async () => {
    getOne.mockResolvedValue({ code: 'ae-banking', schema: {} });
    await expect(service.list('banking', 'kpis')).resolves.toEqual([]);
  });

  it('does not mistake a non-array section for a list', async () => {
    getOne.mockResolvedValue({
      code: 'ae-banking',
      schema: { messaging: { templates: [] } },
    });
    // `messaging` is an object. A caller asking for it as a list gets [] rather
    // than an object that then fails on `.filter`.
    await expect(service.list('banking', 'messaging')).resolves.toEqual([]);
  });

  describe('tenant pins', () => {
    const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
      TenantContext.run({ tenantId }, fn);

    it('serves the pinned country overlay instead of the base pack', async () => {
      findPins.mockResolvedValue([
        {
          configPack: {
            code: 'ae-grc',
            vertical: 'grc',
            isActive: true,
            schema: { regulators: [{ code: 'cbuae' }] },
          },
        },
      ]);
      getOne.mockResolvedValue({ code: 'grc', schema: {} });

      const pack = await inTenant('t-1', () => service.forVertical('grc'));

      // This is the whole point of pinning. Before this, a pin changed nothing
      // on any read path and a UAE bank was served the vertical-wide base.
      expect(pack?.code).toBe('ae-grc');
      expect(getOne).not.toHaveBeenCalled();
    });

    it('ignores a pin to an inactive pack or to another vertical', async () => {
      findPins.mockResolvedValue([
        { configPack: { code: 'ae-grc', vertical: 'grc', isActive: false } },
        { configPack: { code: 'au-immigration', vertical: 'immigration', isActive: true } },
      ]);
      getOne.mockResolvedValue({ code: 'grc', schema: {} });

      const pack = await inTenant('t-1', () => service.forVertical('grc'));

      expect(pack?.code).toBe('grc');
    });

    it('falls back to the base pack outside a tenant context', async () => {
      getOne.mockResolvedValue({ code: 'grc', schema: {} });
      const pack = await service.forVertical('grc');
      expect(pack?.code).toBe('grc');
      expect(findPins).not.toHaveBeenCalled();
    });

    it('degrades to the base pack when the pin lookup fails', async () => {
      findPins.mockRejectedValue(new Error('boom'));
      getOne.mockResolvedValue({ code: 'grc', schema: {} });
      const pack = await inTenant('t-1', () => service.forVertical('grc'));
      expect(pack?.code).toBe('grc');
    });
  });
});
