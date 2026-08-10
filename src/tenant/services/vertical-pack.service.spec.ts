import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { VerticalPackService } from './vertical-pack.service';
import { ConfigPack } from '../entities/config-pack.entity';

/**
 * The resolver is small, but two of its behaviours are load-bearing and were
 * previously reimplemented per feature: the version tiebreak, and treating a
 * missing section as absent rather than as an error.
 */
describe('VerticalPackService', () => {
  let service: VerticalPackService;
  const getOne = jest.fn();
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
    orderBy.mockReset();
    addOrderBy.mockReset();
    const moduleRef = await Test.createTestingModule({
      providers: [
        VerticalPackService,
        {
          provide: getRepositoryToken(ConfigPack),
          useValue: { createQueryBuilder: jest.fn(() => makeQb()) },
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
});
