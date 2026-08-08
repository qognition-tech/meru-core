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
  const findOne = jest.fn();

  beforeEach(async () => {
    findOne.mockReset();
    const moduleRef = await Test.createTestingModule({
      providers: [
        VerticalPackService,
        { provide: getRepositoryToken(ConfigPack), useValue: { findOne } },
      ],
    }).compile();
    service = moduleRef.get(VerticalPackService);
  });

  it('asks for the highest version of an active pack, in SQL', async () => {
    findOne.mockResolvedValue({ code: 'au-immigration', schema: {} });

    await service.forVertical('immigration');

    // The order clause is the assertion. Without it the database returns an
    // arbitrary row, and serving last month's checklist is indistinguishable
    // from serving the current one until a new requirement never appears.
    expect(findOne).toHaveBeenCalledWith({
      where: { vertical: 'immigration', isActive: true },
      order: { version: 'DESC' },
    });
  });

  it('returns null rather than throwing when the vertical is unknown', async () => {
    // A tenant mid-onboarding legitimately has no vertical. Throwing here would
    // turn a normal state into a 500 in every caller.
    await expect(service.forVertical(null)).resolves.toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('returns null rather than throwing when no pack exists', async () => {
    findOne.mockResolvedValue(null);
    await expect(service.section('health', 'prompts')).resolves.toBeNull();
  });

  it('reads a named section out of the pack schema', async () => {
    findOne.mockResolvedValue({
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
    findOne.mockResolvedValue({ code: 'ae-banking', schema: {} });

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
    findOne.mockResolvedValue({ code: 'ae-banking', schema: {} });
    await expect(service.list('banking', 'kpis')).resolves.toEqual([]);
  });

  it('does not mistake a non-array section for a list', async () => {
    findOne.mockResolvedValue({
      code: 'ae-banking',
      schema: { messaging: { templates: [] } },
    });
    // `messaging` is an object. A caller asking for it as a list gets [] rather
    // than an object that then fails on `.filter`.
    await expect(service.list('banking', 'messaging')).resolves.toEqual([]);
  });
});
