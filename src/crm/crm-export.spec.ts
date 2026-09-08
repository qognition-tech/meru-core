import { CrmService } from './crm.service';
import { EntityType, EntityStatus } from './entities/universal-entity.entity';

/**
 * `exportEntitiesCsv` used to delegate to `listEntities({ ...filters, page: 1,
 * limit: MAX_ROWS })`, and `listEntities` clamps whatever `limit` it receives to
 * 200 before the query ever runs — so a request for up to 10,000 rows silently
 * became a request for 200, and `total` (used to decide `X-Export-Truncated`) was
 * computed against that same 200-row page rather than the real matching count. A
 * firm exporting 600 matters got a 200-row file with no signal it was a prefix.
 *
 * `exportEntitiesCsv` now builds its own query via the private
 * `buildEntityListQuery` shared with `listEntities` for WHERE/ORDER BY only, and
 * applies its own 10,000-row cap directly. This suite pins that the two routes'
 * caps are independent, not that `listEntities`'s own 200-row clamp is wrong — it
 * is correct for the list route and untouched here.
 *
 * Same construction style as `crm-convert.service.spec.ts`: `CrmService`
 * constructed directly with a hand-rolled repo, everything but `entityRepo`
 * unused for this concern.
 */
describe('CrmService.exportEntitiesCsv — export has its own cap, independent of the list route\'s 200', () => {
  const TENANT = 't1';

  function row(i: number) {
    return {
      id: `e-${i}`,
      type: EntityType.CASE,
      firstName: 'A',
      lastName: `${i}`,
      email: null,
      phoneNumber: null,
      status: EntityStatus.OPEN,
      dueDate: null,
      assignedTo: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      verticalAttributes: {},
    };
  }

  /**
   * A fake query builder that mirrors the one property of TypeORM's real
   * `getManyAndCount()` this bug turns on: the count query ignores
   * `.skip()`/`.take()`, the row-fetching query does not.
   */
  function buildRepo(totalMatching: number) {
    const allRows = Array.from({ length: totalMatching }, (_, i) => row(i));
    let takeValue: number | undefined;
    let skipValue: number | undefined;

    const qb: any = {
      where: () => qb,
      andWhere: () => qb,
      orderBy: () => qb,
      addOrderBy: () => qb,
      skip: (n: number) => {
        skipValue = n;
        return qb;
      },
      take: (n: number) => {
        takeValue = n;
        return qb;
      },
      getManyAndCount: async () => {
        const start = skipValue ?? 0;
        const end = takeValue !== undefined ? start + takeValue : undefined;
        return [allRows.slice(start, end), allRows.length];
      },
    };

    const entityRepo = { createQueryBuilder: () => qb };
    return { entityRepo, getTake: () => takeValue };
  }

  function buildService(totalMatching: number) {
    const { entityRepo, getTake } = buildRepo(totalMatching);
    const service = new CrmService(
      entityRepo as any,
      {} as any, // tenantSettingsService — unused by this concern
      {} as any, // searchService
      {} as any, // documentHubService
      {} as any, // relations
      {} as any, // access
    );
    return { service, getTake };
  }

  it('exports well past the list route\'s 200-row page size', async () => {
    const { service, getTake } = buildService(600);

    const result = await service.exportEntitiesCsv(TENANT, {});

    expect(getTake()).toBe(10_000);
    expect(result.rows).toBe(600);
    expect(result.truncated).toBe(false);
    // header + 600 data rows, CRLF per toCsv's own convention.
    expect(result.csv.split('\r\n')).toHaveLength(601);
  });

  it('caps at 10,000 and reports truncated:true when the real count exceeds it', async () => {
    const { service } = buildService(10_500);

    const result = await service.exportEntitiesCsv(TENANT, {});

    expect(result.rows).toBe(10_000);
    expect(result.truncated).toBe(true);
  });

  it('does not truncate at exactly the cap', async () => {
    const { service } = buildService(10_000);

    const result = await service.exportEntitiesCsv(TENANT, {});

    expect(result.rows).toBe(10_000);
    expect(result.truncated).toBe(false);
  });

  it('a page/limit on the shared filters type is accepted but ignored — export is the whole set, not one page', async () => {
    const { service, getTake } = buildService(50);

    const result = await service.exportEntitiesCsv(TENANT, { page: 3, limit: 10 });

    expect(getTake()).toBe(10_000);
    expect(result.rows).toBe(50);
  });

  it('listEntities on the same data is still clamped to 200 — the list route\'s own cap is untouched by this fix', async () => {
    const { service } = buildService(600);

    const result = await service.listEntities(TENANT, { limit: 10_000 });

    expect(result.limit).toBe(200);
    expect(result.items).toHaveLength(200);
  });
});
