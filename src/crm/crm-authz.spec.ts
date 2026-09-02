import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CrmService } from './crm.service';
import { CommentService } from './comment.service';
import { AcceptanceService } from './acceptance.service';
import { EntityRelationService } from './entity-relation.service';
import { CrmAccessService } from './crm-access.service';
import { EntityType, EntityStatus } from './entities/universal-entity.entity';
import { Actor } from '../common/access';

/**
 * The centrepiece suite for this hardening pass.
 *
 * `CrmService.getEntity/updateEntity/convertEntity/deleteEntity`,
 * `CommentService.add/list`, `AcceptanceService.record/list` and
 * `EntityRelationService.link/unlink/traverse/completionBlockers` all used to
 * reach their repository with no actor at all — RLS confined the query to the
 * tenant and nothing confined it to the caller inside the tenant. This is the
 * fifth documented instance of that shape (`CrmAccessService`'s own comment)
 * and the class of bug this whole branch exists to close.
 *
 * This suite is deliberately shaped as a matrix, not one test per route: the
 * point is to pin the SHAPE of the authorisation decision (scope × action ×
 * ownership) so that a *new* by-id route added later without going through
 * `CrmAccessService` fails here immediately, rather than needing its own
 * bespoke regression test remembered after the fact.
 *
 * Caveat, stated once for the whole file: these are unit tests against the
 * services directly. They prove the seam works when a controller calls it —
 * they cannot prove every controller calls it. A route that forgets
 * `access.assert()` (or forgets to pass `actor` at all — which the compiler
 * now catches for the required-actor methods, but would not for a *new*
 * method authored without that discipline) is a module-wiring fault this
 * suite does not see. That gap needs an e2e or supertest-level check against
 * the real Nest module graph; see `scripts/smoke/cross-tenant.sh`'s
 * intra-tenant section for the equivalent at the HTTP boundary.
 */
describe('CRM authorisation matrix', () => {
  const T = 't1';
  const OWNED_ID = 'e-owned';
  const TARGET_ID = 'e-target';

  const ACTORS: Record<string, Actor> = {
    firm_admin: { id: 'staff-1', roles: ['firm_admin'] },
    staff: { id: 'staff-2', roles: ['staff'] },
    'client-own': { id: 'client-a', roles: ['client'] },
    'client-other': { id: 'client-b', roles: ['client'] },
    'platform_admin-bare': { id: 'op-1', roles: ['platform_admin'] },
  };
  type ActorKey = keyof typeof ACTORS;
  const ACTOR_KEYS = Object.keys(ACTORS) as ActorKey[];

  /**
   * Minimal fake `universal_entities` table, shared by every service under
   * test the way the real Postgres table is. Deliberately hand-rolled rather
   * than pulled from a shared test util — see the existing specs in this
   * directory, which all do the same, keyed to the exact where-clauses each
   * service issues.
   */
  function buildHarness() {
    const store = new Map<string, any>();
    let counter = 0;

    const now = () => new Date();

    store.set(OWNED_ID, {
      id: OWNED_ID,
      tenantId: T,
      type: EntityType.LEAD,
      status: EntityStatus.OPEN,
      assignedTo: 'client-a',
      verticalAttributes: {},
      relationships: [],
    });
    store.set(TARGET_ID, {
      id: TARGET_ID,
      tenantId: T,
      type: EntityType.LEAD,
      status: EntityStatus.OPEN,
      assignedTo: null,
      verticalAttributes: {},
      relationships: [],
    });

    const entityRepo = {
      findOne: async ({ where }: any) => {
        let rows = [...store.values()];
        if (where.id !== undefined) rows = rows.filter((r) => r.id === where.id);
        if (where.tenantId !== undefined)
          rows = rows.filter((r) => r.tenantId === where.tenantId);
        if (where.type !== undefined) rows = rows.filter((r) => r.type === where.type);
        return rows[0] ?? null;
      },
      find: async ({ where }: any) => {
        let rows = [...store.values()];
        if (where.tenantId !== undefined)
          rows = rows.filter((r) => r.tenantId === where.tenantId);
        const ids: string[] | undefined = where.id?._value;
        if (ids) rows = rows.filter((r) => ids.includes(r.id));
        return rows;
      },
      save: async (e: any) => {
        if (!e.id) e.id = `id-${++counter}`;
        e.updatedAt = now();
        e.createdAt = e.createdAt ?? now();
        store.set(e.id, e);
        return e;
      },
      create: (partial: any) => ({ ...partial }),
      remove: async (e: any) => {
        store.delete(e.id);
      },
      update: async (criteria: any, partial: any) => {
        const row = [...store.values()].find(
          (r) =>
            (criteria.id === undefined || r.id === criteria.id) &&
            (criteria.tenantId === undefined || r.tenantId === criteria.tenantId) &&
            (criteria.type === undefined || r.type === criteria.type),
        );
        if (!row) return { affected: 0 };
        Object.assign(row, partial);
        return { affected: 1 };
      },
      // CommentService.list's query builder. Keyed to the exact filters that
      // method issues, the same way the sibling specs in this directory do.
      createQueryBuilder: () => {
        const params: Record<string, unknown> = {};
        const builder = {
          where: (_sql: string, p: any = {}) => {
            Object.assign(params, p);
            return builder;
          },
          andWhere: (_sql: string, p: any = {}) => {
            Object.assign(params, p);
            return builder;
          },
          orderBy: () => builder,
          getMany: async () =>
            [...store.values()].filter(
              (r) =>
                r.type === EntityType.NOTE &&
                r.tenantId === params.tenantId &&
                r.verticalAttributes?.parentEntityId === params.parentId &&
                !r.deletedAt,
            ),
        };
        return builder;
      },
    };

    const relationRows: any[] = [];
    const relationRepo = {
      findOne: async ({ where }: any) =>
        relationRows.find(
          (r) =>
            r.relationKey === where.relationKey &&
            r.fromId === where.fromId &&
            r.toId === where.toId,
        ) ?? null,
      find: async ({ where }: any) =>
        relationRows.filter((r) => {
          if (where.fromId && r.fromId !== where.fromId) return false;
          if (where.toId && r.toId !== where.toId) return false;
          return true;
        }),
      count: async () => 0,
      create: (x: any) => ({ ...x }),
      save: async (r: any) => {
        relationRows.push(r);
        return r;
      },
      delete: async () => ({ affected: 1 }),
    };

    const packs = {
      section: async () => [
        {
          key: 'blocks',
          label: 'Blocks',
          fromType: 'lead',
          toType: 'lead',
          cardinality: 'many_to_many' as const,
        },
      ],
    };

    const access = new CrmAccessService();
    const relations = new EntityRelationService(
      relationRepo as any,
      entityRepo as any,
      packs as any,
      access,
    );
    const crm = new CrmService(
      entityRepo as any,
      {} as any,
      { indexEntityData: async () => undefined } as any,
      {} as any,
      relations,
      access,
    );
    const comments = new CommentService(entityRepo as any, access);
    const acceptance = new AcceptanceService(
      entityRepo as any,
      { logEvent: async () => undefined } as any,
      access,
    );

    return { crm, comments, acceptance, relations, access, store, relationRows };
  }

  type Harness = ReturnType<typeof buildHarness>;

  /** `own` scope reading a record that is not theirs is 404, never 403 — see CrmAccessService.assert. */
  const NOT_FOUND = 'not-found';
  /** `own` scope acting on a record they may read but not change. */
  const FORBIDDEN = 'forbidden';
  const ALLOWED = 'allowed';

  interface Case {
    name: string;
    run: (h: Harness, actor: Actor) => Promise<unknown>;
    outcome: Record<ActorKey, typeof ALLOWED | typeof FORBIDDEN | typeof NOT_FOUND>;
  }

  const READ_GATED = {
    firm_admin: ALLOWED,
    staff: ALLOWED,
    'client-own': ALLOWED,
    'client-other': NOT_FOUND,
    'platform_admin-bare': NOT_FOUND,
  } as const;

  const WRITE_GATED = {
    firm_admin: ALLOWED,
    staff: ALLOWED,
    'client-own': FORBIDDEN,
    'client-other': NOT_FOUND,
    'platform_admin-bare': NOT_FOUND,
  } as const;

  const CASES: Case[] = [
    {
      name: 'getEntity (read)',
      run: (h, actor) => h.crm.getEntity(OWNED_ID, T, actor),
      outcome: READ_GATED,
    },
    {
      name: 'updateEntity (write)',
      run: (h, actor) => h.crm.updateEntity(OWNED_ID, T, actor, { firstName: 'Changed' }),
      outcome: WRITE_GATED,
    },
    {
      name: 'convertEntity (write)',
      run: (h, actor) => h.crm.convertEntity(OWNED_ID, T, actor, EntityType.PERSON),
      outcome: WRITE_GATED,
    },
    {
      name: 'deleteEntity (delete)',
      run: (h, actor) => h.crm.deleteEntity(OWNED_ID, T, actor),
      outcome: WRITE_GATED,
    },
    {
      name: 'comments.add (read-gated on the parent)',
      run: (h, actor) =>
        h.comments.add(
          T,
          'record',
          OWNED_ID,
          { body: 'hello', authorId: actor.id },
          actor,
        ),
      outcome: READ_GATED,
    },
    {
      name: 'comments.list (read-gated on the parent)',
      run: (h, actor) => h.comments.list(T, OWNED_ID, actor),
      outcome: READ_GATED,
    },
    {
      name: 'acceptance.record (read-gated on the parent)',
      run: (h, actor) =>
        h.acceptance.record(
          T,
          OWNED_ID,
          { subject: 'terms', userId: actor.id, email: 'x@example.com' },
          actor,
        ),
      outcome: READ_GATED,
    },
    {
      name: 'acceptance.list (read-gated on the parent)',
      run: (h, actor) => h.acceptance.list(T, OWNED_ID, actor),
      outcome: READ_GATED,
    },
    {
      // Gated on BOTH ends, which is why `client-own` is NOT_FOUND here while
      // it is ALLOWED on every other `OWNED_ID` case: the caller owns the
      // "from" record but `TARGET_ID` is `assignedTo: null`, so they cannot
      // read it. Checking only "from" was a privilege escalation — owning one
      // record let a client attach any id in the tenant and then read it back
      // in full through `traverse()`. If this case ever goes green as ALLOWED
      // again, that hole is back open.
      name: 'relations.link (read-gated on BOTH ends)',
      run: (h, actor) => h.relations.link(T, actor, 'immigration', 'blocks', OWNED_ID, TARGET_ID),
      outcome: { ...READ_GATED, 'client-own': NOT_FOUND },
    },
    {
      name: 'relations.unlink (read-gated on the "from" entity)',
      run: (h, actor) => h.relations.unlink(T, actor, 'blocks', OWNED_ID, TARGET_ID),
      outcome: READ_GATED,
    },
    {
      name: 'relations.traverse (read-gated on the entity)',
      run: (h, actor) => h.relations.traverse(T, actor, 'immigration', OWNED_ID),
      outcome: READ_GATED,
    },
    {
      name: 'relations.completionBlockers (read-gated on the entity)',
      run: (h, actor) => h.relations.completionBlockers(T, actor, 'immigration', OWNED_ID),
      outcome: READ_GATED,
    },
  ];

  describe.each(CASES)('$name', ({ run, outcome }) => {
    it.each(ACTOR_KEYS)('%s', async (actorKey) => {
      const h = buildHarness();
      const actor = ACTORS[actorKey];
      const expected = outcome[actorKey];

      if (expected === ALLOWED) {
        // Not `.toBeDefined()` — `deleteEntity` and `unlink` resolve to
        // `void`. The assertion that matters is that the promise settles by
        // resolving, not rejecting.
        await expect(run(h, actor)).resolves.not.toBeInstanceOf(Error);
      } else if (expected === FORBIDDEN) {
        await expect(run(h, actor)).rejects.toBeInstanceOf(ForbiddenException);
      } else {
        // NOT_FOUND: the disclosure-minimising shape. A 403 here would
        // confirm the record exists to a caller who cannot see it at all.
        await expect(run(h, actor)).rejects.toBeInstanceOf(NotFoundException);
        await expect(run(h, actor)).rejects.not.toBeInstanceOf(ForbiddenException);
      }
    });
  });

  describe('platform_admin, bare, is own scope by design', () => {
    it('does not silently widen to tenant reach — only runAsGod does', async () => {
      // Easy to "fix" wrongly later: a bare platform_admin token looks like
      // it should see everything, and it must not. Operator reach into a
      // tenant is the audited `TenancyService.runAsGod` path, which writes a
      // CRITICAL entry before the access happens. A bare token is a claim
      // about identity, not a record that anyone looked.
      const h = buildHarness();
      const bareOperator = ACTORS['platform_admin-bare'];
      expect(h.access.scopeOf(bareOperator)).toBe('own');
      await expect(h.crm.getEntity(OWNED_ID, T, bareOperator)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('regression: includeInternal must not leak past a client', () => {
    // The real incident this closes: `GET /crm/entities/:id/comments
    // ?includeInternal=true` used to read the flag straight off the query
    // string with no role check, so a client could ask for — and receive —
    // the firm's private file notes on their own case.
    it('a client asking for includeInternal never receives internal notes', async () => {
      const h = buildHarness();
      const staff = ACTORS.staff;
      const clientOwn = ACTORS['client-own'];

      await h.comments.add(
        T,
        'record',
        OWNED_ID,
        { body: 'client-visible note', authorId: clientOwn.id, internal: false },
        clientOwn,
      );
      await h.comments.add(
        T,
        'record',
        OWNED_ID,
        { body: 'staff-only casework note', authorId: staff.id, internal: true },
        staff,
      );

      const asClient = await h.comments.list(T, OWNED_ID, clientOwn, {
        includeInternal: true,
      });
      expect(asClient.map((c) => c.body)).toEqual(['client-visible note']);
      expect(asClient.some((c) => c.internal)).toBe(false);

      const asStaff = await h.comments.list(T, OWNED_ID, staff, { includeInternal: true });
      expect(asStaff).toHaveLength(2);
    });

    it('a client cannot mark their own comment internal', async () => {
      const h = buildHarness();
      const clientOwn = ACTORS['client-own'];
      const saved = await h.comments.add(
        T,
        'record',
        OWNED_ID,
        { body: 'trying to hide this', authorId: clientOwn.id, internal: true },
        clientOwn,
      );
      expect(saved.internal).toBe(false);
    });
  });

  describe('comments.remove — keyed on the comment author, not the entity assignee', () => {
    it('the author may remove their own comment', async () => {
      const h = buildHarness();
      const clientOwn = ACTORS['client-own'];
      const saved = await h.comments.add(
        T,
        'record',
        OWNED_ID,
        { body: 'mine', authorId: clientOwn.id },
        clientOwn,
      );
      await expect(h.comments.remove(T, saved.id, clientOwn)).resolves.toEqual({
        deleted: true,
      });
    });

    it('a different client on the SAME record cannot remove someone else\'s comment, and gets 404', async () => {
      const h = buildHarness();
      const clientA = ACTORS['client-own'];
      const clientB = ACTORS['client-other'];
      // client-b is not assigned to OWNED_ID, but that is irrelevant here —
      // comment ownership is the author, not the parent's assignee.
      const saved = await h.comments.add(
        T,
        'record',
        OWNED_ID,
        { body: 'client-a wrote this', authorId: clientA.id },
        clientA,
      );
      await expect(h.comments.remove(T, saved.id, clientB)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('staff may remove any comment regardless of authorship', async () => {
      const h = buildHarness();
      const clientOwn = ACTORS['client-own'];
      const staff = ACTORS.staff;
      const saved = await h.comments.add(
        T,
        'record',
        OWNED_ID,
        { body: 'mine', authorId: clientOwn.id },
        clientOwn,
      );
      await expect(h.comments.remove(T, saved.id, staff)).resolves.toEqual({ deleted: true });
    });
  });
});
