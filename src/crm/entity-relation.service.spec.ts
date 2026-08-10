import { EntityRelationService, type RelationshipDefinition } from './entity-relation.service';
import { EntityRelation } from './entities/entity-relation.entity';
import {
  EntityStatus,
  EntityType,
  UniversalEntity,
} from './entities/universal-entity.entity';
import { BadRequestException } from '@nestjs/common';

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

  function build(entities: UniversalEntity[], relations: EntityRelation[] = []) {
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
            if (where.relationKey?._value && !where.relationKey._value.includes(r.relationKey))
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

    const packs = { section: jest.fn(() => Promise.resolve(definitions)) };

    return {
      service: new EntityRelationService(
        relationRepo as never,
        entityRepo as never,
        packs as never,
      ),
      rows,
    };
  }

  it('creates an edge the pack describes', async () => {
    const { service, rows } = build([
      entity(A, EntityType.MILESTONE),
      entity(B, EntityType.MILESTONE),
    ]);

    await service.link(TENANT, 'banking', 'blocks', A, B);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ relationKey: 'blocks', fromId: A, toId: B });
  });

  it('refuses a relation key the pack does not define, and lists what it does', async () => {
    const { service } = build([
      entity(A, EntityType.MILESTONE),
      entity(B, EntityType.MILESTONE),
    ]);

    // The jsonb array this replaces accepted any string, so a typo produced an
    // edge that existed and matched no definition.
    await expect(
      service.link(TENANT, 'banking', 'blokcs', A, B),
    ).rejects.toThrow(/available: blocks/);
  });

  it('refuses types the relation was not declared for', async () => {
    const { service } = build([
      entity(A, EntityType.CASE),
      entity(B, EntityType.MILESTONE),
    ]);

    await expect(
      service.link(TENANT, 'banking', 'blocks', A, B),
    ).rejects.toThrow(/milestone → milestone, not case → milestone/);
  });

  it('refuses a self-edge', async () => {
    const { service } = build([entity(A, EntityType.MILESTONE)]);

    // On a blocking relation this is a record that can never complete.
    await expect(
      service.link(TENANT, 'banking', 'blocks', A, A),
    ).rejects.toThrow(BadRequestException);
  });

  it('is idempotent — linking twice is what a double-clicked button does', async () => {
    const { service, rows } = build([
      entity(A, EntityType.MILESTONE),
      entity(B, EntityType.MILESTONE),
    ]);

    await service.link(TENANT, 'banking', 'blocks', A, B);
    await service.link(TENANT, 'banking', 'blocks', A, B);

    expect(rows).toHaveLength(1);
  });

  it('enforces one_to_one on both sides', async () => {
    const { service } = build([
      entity(A, EntityType.VENDOR),
      entity(B, EntityType.PERSON, null),
      entity(C, EntityType.VENDOR),
    ]);

    await service.link(TENANT, 'banking', 'primary_contact', A, B);
    // The target already has a primary-contact edge pointing at it.
    await expect(
      service.link(TENANT, 'banking', 'primary_contact', C, B),
    ).rejects.toThrow(/one_to_one/);
  });

  it('allows many sources under one_to_many', async () => {
    const { service, rows } = build([
      entity(A, EntityType.CASE),
      entity(B, EntityType.NOTE, null),
      entity(C, EntityType.CASE),
    ]);

    await service.link(TENANT, 'immigration', 'supporting_document', A, B);
    await service.link(TENANT, 'immigration', 'supporting_document', C, B);

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

      const blockers = await service.completionBlockers(TENANT, 'banking', A);
      expect(blockers.map((b) => b.id)).toEqual([B]);
      await expect(
        service.assertCompletable(TENANT, 'banking', A),
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
        service.assertCompletable(TENANT, 'banking', A),
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

      const blockers = await service.completionBlockers(TENANT, 'banking', A);
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
    const result = await service.traverse(TENANT, 'banking', B);
    expect(result.incoming).toHaveLength(1);
    expect(result.incoming[0].label).toBe('Blocked by');
    expect(result.outgoing).toHaveLength(0);
  });
});
