import { CrmService } from './crm.service';
import { EntityType } from './entities/universal-entity.entity';

/**
 * The client list must fail CLOSED.
 *
 * `CrmController.clientScoped` always SETS `subjectEmail` for a `client`-role
 * caller, to `user.email`. `buildEntityListQuery` then tested it for
 * truthiness:
 *
 *     if (filters.subjectEmail) qb.andWhere(...)
 *
 * so an empty or absent JWT email made the predicate disappear entirely and
 * the client received **every record in the tenant** — not zero. The leak the
 * `subjectEmail` column was added to close, reintroduced from the opposite
 * direction by the commit that closed it, and caught in review rather than by
 * a test.
 *
 * The distinction this suite pins is narrow and easy to lose again: "the key
 * is absent" (an unscoped staff query) and "the key is present but unusable"
 * (a client whose identity we could not resolve) must produce opposite
 * outcomes. Truthiness cannot tell them apart. Nothing else in the CRM tests
 * looks at the generated SQL, so without this the next refactor of that `if`
 * has no safety net at all.
 */
describe('client list scope fails closed', () => {
  /**
   * Records the predicates the service adds. Only `andWhere` matters here —
   * the assertions are about which conditions exist, never their order.
   */
  function harness() {
    const conditions: string[] = [];
    const qb: any = {
      where: (c: string) => {
        conditions.push(c);
        return qb;
      },
      andWhere: (c: string) => {
        conditions.push(c);
        return qb;
      },
      orderBy: () => qb,
      addOrderBy: () => qb,
      skip: () => qb,
      take: () => qb,
      getManyAndCount: async () => [[], 0],
      getRawMany: async () => [],
      select: () => qb,
    };

    const service = new CrmService(
      { createQueryBuilder: () => qb } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    return { service, conditions };
  }

  const subjectPredicate = (c: string) => c.includes('"subjectEmail"');
  const denyAll = (c: string) => c.replace(/\s/g, '') === '1=0';

  it('filters by subject when the client’s email resolves', async () => {
    const { service, conditions } = harness();
    await service.listEntities('t1', {
      type: EntityType.CASE,
      subjectEmail: 'applicant@example.com',
    });

    expect(conditions.some(subjectPredicate)).toBe(true);
    expect(conditions.some(denyAll)).toBe(false);
  });

  it('denies everything when the client’s email is empty', async () => {
    // The bug. Previously: no subject predicate, no denial — every record in
    // the tenant returned to a client.
    const { service, conditions } = harness();
    await service.listEntities('t1', {
      type: EntityType.CASE,
      subjectEmail: '',
    });

    expect(conditions.some(denyAll)).toBe(true);
    expect(conditions.some(subjectPredicate)).toBe(false);
  });

  it('denies everything when the client’s email is only whitespace', async () => {
    const { service, conditions } = harness();
    await service.listEntities('t1', {
      type: EntityType.CASE,
      subjectEmail: '   ',
    });

    expect(conditions.some(denyAll)).toBe(true);
  });

  it('leaves a staff query unscoped by subject', async () => {
    // `clientScoped` does not set the key at all for staff. Absent must stay
    // "no subject filter" — the opposite outcome to present-but-empty, which
    // is the whole point of keying on `!== undefined`.
    const { service, conditions } = harness();
    await service.listEntities('t1', { type: EntityType.CASE });

    expect(conditions.some(subjectPredicate)).toBe(false);
    expect(conditions.some(denyAll)).toBe(false);
  });

  it('always scopes by tenant, whatever the subject filter does', async () => {
    const { service, conditions } = harness();
    await service.listEntities('t1', { subjectEmail: '' });

    expect(conditions.some((c) => c.includes('"tenantId"'))).toBe(true);
  });
});
