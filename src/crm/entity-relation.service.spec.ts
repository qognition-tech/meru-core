import {
  EntityRelationService,
  type RelationshipDefinition,
} from './entity-relation.service';
import { EntityRelation } from './entities/entity-relation.entity';
import {
  EntityStatus,
  EntityType,
  UniversalEntity,
} from './entities/universal-entity.entity';
import { BadRequestException } from '@nestjs/common';
import { CrmAccessService } from './crm-access.service';
import { PlatformRole } from '../iam/enums/platform-role.enum';

// `link`/`unlink`/`traverse`/`completionBlockers`/`assertCompletable` now
// require an `actor` and check read access on the "from"/parent entity
// (`CrmAccessService`). These fixtures don't set `assignedTo`, so a
// `firm_admin` actor (tenant scope, unrestricted read) keeps this suite
// pinning relation behaviour rather than re-deriving ownership rules, which
// have their own spec.
const STAFF_ACTOR = { id: 'staff-1', roles: [PlatformRole.FIRM_ADMIN] };

describe('EntityRelationService', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';
  const A = 'aaaaaaaa-0000-0000-0000-000000000001';
  const B = 'bbbbbbbb-0000-0000-0000-000000000002';
  const C = 'cccccccc-0000-0000-0000-000000000003';

  const definitions: RelationshipDefinition[] = [
    {
      key: 'blocks',
      label: 'Blocks',
      fromType: 'milestone',
      toType: 'milestone',
      inverseLabel: 'Blocked by',
      cardinality: 'many_to_many',
      blocksCompletion: true,
    },
    {
      key: 'primary_contact',
      label: 'Primary contact',
      fromType: 'vendor',
      toType: 'person',
      cardinality: 'one_to_one',
    },
    {
      key: 'supporting_document',
      label: 'Supporting document',
      fromType: 'case',
      toType: 'note',
      cardinality: 'one_to_many',
    },
  ];

  const entity = (
    id: string,
    type: EntityType,
    status: EntityStatus | null = EntityStatus.OPEN,
  ) =>
    ({
      id,
      tenantId: TENANT,
      type,
      status,
    }) as UniversalEntity;

  function build(
    entities: UniversalEntity[],
    relations: EntityRelation[] = [],
  ) {
    const rows = [...relations];

    const relationRepo = {
      findOne: jest.fn(({ where }: any) =>
        Promise.resolve(
          rows.find(
            (r) =>
              r.relationKey === where.relationKey &&
              r.fromId === where.fromId &&
              r.toId === where.toId,
          ) ?? null,
        ),
      ),
      find: jest.fn(({ where }: any) =>
        Promise.resolve(
          rows.filter((r) => {
            if (where.fromId && r.fromId !== where.fromId) return false;
            if (where.toId && r.toId !== where.toId) return false;
            if (
              where.relationKey?._value &&
              !where.relationKey._value.includes(r.relationKey)
            )
              return false;
            return true;
          }),
        ),
      ),
      count: jest.fn(({ where }: any) =>
        Promise.resolve(
          rows.filter(
            (r) =>
              r.relationKey === where.relationKey &&
              (where.fromId ? r.fromId === where.fromId : true) &&
              (where.toId ? r.toId === where.toId : true),
          ).length,
        ),
      ),
      create: jest.fn(
        (x: Partial<EntityRelation>) => ({ ...x }) as EntityRelation,
      ),
      save: jest.fn((r: EntityRelation) => {
        rows.push(r);
        return Promise.resolve(r);
      }),
      delete: jest.fn(() => Promise.resolve({ affected: 1 })),
    };

    const entityRepo = {
      findOne: jest.fn(({ where }: any) =>
        Promise.resolve(entities.find((e) => e.id === where.id) ?? null),
      ),
      find: jest.fn(({ where }: any) => {
        const ids: string[] = where.id?._value ?? [];
        return Promise.resolve(entities.filter((e) => ids.includes(e.id)));
      }),
    };

    const packs = { section: jest.fn(() => Promise.resolve(definitions)) };

    return {
      service: new EntityRelationService(
        relationRepo as never,
        entityRepo as never,
        packs as never,
        new CrmAccessService(),
      ),
      rows,
    };
  }

  it('creates an edge the pack describes', async () => {
    const { service, rows } = build([
      entity(A, EntityType.MILESTONE),
      entity(B, EntityType.MILESTONE),
    ]);

    await service.link(TENANT, STAFF_ACTOR, 'banking', 'blocks', A, B);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      relationKey: 'blocks',
      fromId: A,
      toId: B,
    });
  });

  it('refuses a relation key the pack does not define, and lists what it does', async () => {
    const { service } = build([
      entity(A, EntityType.MILESTONE),
      entity(B, EntityType.MILESTONE),
    ]);

    // The jsonb array this replaces accepted any string, so a typo produced an
    // edge that existed and matched no definition.
    await expect(
      service.link(TENANT, STAFF_ACTOR, 'banking', 'blokcs', A, B),
    ).rejects.toThrow(/available: blocks/);
  });

  it('refuses types the relation was not declared for', async () => {
    const { service } = build([
      entity(A, EntityType.CASE),
      entity(B, EntityType.MILESTONE),
    ]);

    await expect(
      service.link(TENANT, STAFF_ACTOR, 'banking', 'blocks', A, B),
    ).rejects.toThrow(/milestone → milestone, not case → milestone/);
  });

  it('refuses a self-edge', async () => {
    const { service } = build([entity(A, EntityType.MILESTONE)]);

    // On a blocking relation this is a record that can never complete.
    await expect(
      service.link(TENANT, STAFF_ACTOR, 'banking', 'blocks', A, A),
    ).rejects.toThrow(BadRequestException);
  });

  it('is idempotent — linking twice is what a double-clicked button does', async () => {
    const { service, rows } = build([
      entity(A, EntityType.MILESTONE),
      entity(B, EntityType.MILESTONE),
    ]);

    await service.link(TENANT, STAFF_ACTOR, 'banking', 'blocks', A, B);
    await service.link(TENANT, STAFF_ACTOR, 'banking', 'blocks', A, B);

    expect(rows).toHaveLength(1);
  });

  it('enforces one_to_one on both sides', async () => {
    const { service } = build([
      entity(A, EntityType.VENDOR),
      entity(B, EntityType.PERSON, null),
      entity(C, EntityType.VENDOR),
    ]);

    await service.link(TENANT, STAFF_ACTOR, 'banking', 'primary_contact', A, B);
    // The target already has a primary-contact edge pointing at it.
    await expect(
      service.link(TENANT, STAFF_ACTOR, 'banking', 'primary_contact', C, B),
    ).rejects.toThrow(/one_to_one/);
  });

  it('allows many sources under one_to_many', async () => {
    const { service, rows } = build([
      entity(A, EntityType.CASE),
      entity(B, EntityType.NOTE, null),
      entity(C, EntityType.CASE),
    ]);

    await service.link(TENANT, STAFF_ACTOR, 'immigration', 'supporting_document', A, B);
    await service.link(TENANT, STAFF_ACTOR, 'immigration', 'supporting_document', C, B);

    expect(rows).toHaveLength(2);
  });

  describe('completion blocking', () => {
    it('reports an open target as a blocker', async () => {
      const { service } = build(
        [
          entity(A, EntityType.MILESTONE),
          entity(B, EntityType.MILESTONE, EntityStatus.IN_PROGRESS),
        ],
        [
          {
            relationKey: 'blocks',
            fromId: A,
            toId: B,
            tenantId: TENANT,
          } as EntityRelation,
        ],
      );

      const blockers = await service.completionBlockers(TENANT, STAFF_ACTOR, 'banking', A);
      expect(blockers.map((b) => b.id)).toEqual([B]);
      await expect(
        service.assertCompletable(TENANT, STAFF_ACTOR, 'banking', A),
      ).rejects.toThrow(/still open/);
    });

    it('clears once the target closes', async () => {
      const { service } = build(
        [
          entity(A, EntityType.MILESTONE),
          entity(B, EntityType.MILESTONE, EntityStatus.CLOSED),
        ],
        [
          {
            relationKey: 'blocks',
            fromId: A,
            toId: B,
            tenantId: TENANT,
          } as EntityRelation,
        ],
      );

      await expect(
        service.assertCompletable(TENANT, STAFF_ACTOR, 'banking', A),
      ).resolves.toBeUndefined();
    });

    it('never blocks on a record that has no lifecycle', async () => {
      // A note has a null status. Treating null as "open" would let an
      // attached note freeze a case forever.
      const { service } = build(
        [entity(A, EntityType.CASE), entity(B, EntityType.NOTE, null)],
        [
          {
            relationKey: 'blocks',
            fromId: A,
            toId: B,
            tenantId: TENANT,
          } as EntityRelation,
        ],
      );

      const blockers = await service.completionBlockers(TENANT, STAFF_ACTOR, 'banking', A);
      expect(blockers).toHaveLength(0);
    });
  });

  it('labels the inverse direction from the pack', async () => {
    const { service } = build(
      [entity(A, EntityType.MILESTONE), entity(B, EntityType.MILESTONE)],
      [
        {
          relationKey: 'blocks',
          fromId: A,
          toId: B,
          tenantId: TENANT,
        } as EntityRelation,
      ],
    );

    // B's view of the same edge. This direction is the one the jsonb array
    // could not answer at all.
    const result = await service.traverse(TENANT, STAFF_ACTOR, 'banking', B);
    expect(result.incoming).toHaveLength(1);
    expect(result.incoming[0].label).toBe('Blocked by');
    expect(result.outgoing).toHaveLength(0);
  });
});

/**
 * REGRESSION — found during the authz hardening review, NOT fixed by it.
 *
 * `link()` and `unlink()` check `CrmAccessService.assert(from, actor, 'read')`
 * on the "from" entity only. `to` is fetched with a plain tenant-scoped
 * lookup and never passed through the access seam at all. `traverse()` and
 * `completionBlockers()` check the parent, then return the FULL linked
 * `UniversalEntity` rows for every edge with no per-target check either.
 *
 * Composed, this is a privilege escalation from `own` scope to full
 * tenant-wide read: an `own`-scope caller (a `client`) who owns exactly one
 * record can `link()` it to ANY other record in the tenant they can merely
 * guess or discover the id of — no ownership of the target is required — and
 * then call `traverse()` on their own record to receive that other record's
 * complete `verticalAttributes`, which on ImmiStack is where passport and
 * visa data lives. This is the exact bug shape `CrmAccessService`'s own class
 * doc calls "the fifth documented instance" — hiding in the service meant to
 * close it.
 *
 * Reproduction (see the tests below): client A owns entity A. Entity B is
 * assigned to client B and A has no relationship to it. A calls
 * `link(..., 'blocks', A, B)` — a call `CrmAccessService` should refuse
 * because A cannot even read B — and it succeeds. A then calls
 * `traverse(..., A)` and receives B's full record back, despite never having
 * read access to B.
 *
 * These tests assert the CORRECT behaviour and are expected to fail against
 * the current implementation. Do not "fix" them by asserting the leak is
 * fine — the fix belongs in `entity-relation.service.ts` (out of scope for a
 * *.spec.ts-only change), gated on `CrmAccessService.assert(to, actor,
 * 'read')` in `link()`, and on a per-target access filter in `traverse()`
 * and `completionBlockers()`'s result sets.
 */
describe('EntityRelationService — cross-record read escalation (KNOWN BUG, unfixed)', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';
  const OWNED = 'aaaaaaaa-1111-1111-1111-000000000001';
  const OTHER_CLIENTS_RECORD = 'bbbbbbbb-1111-1111-1111-000000000002';

  const clientA = { id: 'client-a', roles: [PlatformRole.CLIENT] };

  const caseCaseDefinitions: RelationshipDefinition[] = [
    {
      key: 'blocks',
      label: 'Blocks',
      fromType: 'case',
      toType: 'case',
      cardinality: 'many_to_many',
    },
  ];

  function build(entities: UniversalEntity[]) {
    const rows: EntityRelation[] = [];
    const relationRepo = {
      findOne: jest.fn(({ where }: any) =>
        Promise.resolve(
          rows.find(
            (r) =>
              r.relationKey === where.relationKey &&
              r.fromId === where.fromId &&
              r.toId === where.toId,
          ) ?? null,
        ),
      ),
      find: jest.fn(({ where }: any) =>
        Promise.resolve(
          rows.filter((r) => {
            if (where.fromId && r.fromId !== where.fromId) return false;
            if (where.toId && r.toId !== where.toId) return false;
            return true;
          }),
        ),
      ),
      count: jest.fn(() => Promise.resolve(0)),
      create: jest.fn((x: Partial<EntityRelation>) => ({ ...x }) as EntityRelation),
      save: jest.fn((r: EntityRelation) => {
        rows.push(r);
        return Promise.resolve(r);
      }),
      delete: jest.fn(() => Promise.resolve({ affected: 1 })),
    };
    const entityRepo = {
      findOne: jest.fn(({ where }: any) =>
        Promise.resolve(entities.find((e) => e.id === where.id) ?? null),
      ),
      find: jest.fn(({ where }: any) => {
        const ids: string[] = where.id?._value ?? [];
        return Promise.resolve(entities.filter((e) => ids.includes(e.id)));
      }),
    };
    const packs = { section: jest.fn(() => Promise.resolve(caseCaseDefinitions)) };
    return {
      service: new EntityRelationService(
        relationRepo as never,
        entityRepo as never,
        packs as never,
        new CrmAccessService(),
      ),
    };
  }

  const entity = (id: string, assignedTo: string | null) =>
    ({
      id,
      tenantId: TENANT,
      type: EntityType.CASE,
      status: EntityStatus.OPEN,
      assignedTo,
    }) as UniversalEntity;

  it('refuses to link an owned record to a record the actor cannot read', async () => {
    const { service } = build([
      entity(OWNED, 'client-a'),
      entity(OTHER_CLIENTS_RECORD, 'client-b'),
    ]);

    await expect(
      service.link(TENANT, clientA, 'immigration', 'blocks', OWNED, OTHER_CLIENTS_RECORD),
    ).rejects.toBeTruthy(); // currently resolves — see file header
  });

  it('does not return a linked record the actor could not read directly, from traverse()', async () => {
    const { service } = build([
      entity(OWNED, 'client-a'),
      entity(OTHER_CLIENTS_RECORD, 'client-b'),
    ]);

    // Bypass `link`'s own (missing) guard to isolate `traverse`'s behaviour:
    // create the edge directly, as if it were created by staff or by the
    // `link` bug above, and confirm `traverse` still does not hand back a
    // record this actor cannot read on its own.
    await service.link(TENANT, { id: 'staff-1', roles: [PlatformRole.STAFF] }, 'immigration', 'blocks', OWNED, OTHER_CLIENTS_RECORD);

    const result = await service.traverse(TENANT, clientA, 'immigration', OWNED);
    expect(result.outgoing).toHaveLength(0); // currently 1, with the other client's full record
  });
});
