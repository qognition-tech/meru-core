import { WorkflowEngineService } from './workflow.service';
import { InstanceStatus } from './entities/workflow-instance.entity';
import { Actor } from '../common/access';

/**
 * The list-route regression `crm-authz.spec.ts` and `workflow-permissions.spec.ts`
 * did not cover: `GET /workflows/instances` (`WorkflowEngineService.listInstances`).
 *
 * The singular routes (`getInstance`, `getAvailableTransitions`) were narrowed by
 * `assertInstanceOwnership` in a prior pass, but the list route was left querying
 * `where: { tenantId }` only — a `client` token got every matter in the tenant,
 * `context` included. This suite pins the list route's actor scoping directly, the
 * same two-source ownership (`startedBy`, or the linked CRM entity — owned by
 * `assignedTo` for staff and by `subjectEmail` for the applicant it is about)
 * `assertInstanceOwnership` already checks per-row.
 *
 * Deliberately not a full Nest DI harness: `listInstances` and the `ownedEntityIds`
 * helper it calls touch only `instanceRepo` and `entityRepo`, so the other eleven
 * constructor dependencies are unused stubs — same approach `crm-authz.spec.ts`
 * takes for `CrmService`.
 */
describe('WorkflowEngineService.listInstances — list-route actor scoping', () => {
  const T = 't1';
  const OTHER_T = 't2';

  const ACTORS: Record<string, Actor> = {
    firm_admin: { id: 'staff-1', roles: ['firm_admin'] },
    staff: { id: 'staff-2', roles: ['staff'] },
    'client-own': { id: 'client-a', roles: ['client'] },
    'client-other': { id: 'client-b', roles: ['client'] },
  };

  const OWNED_ENTITY_ID = 'e-owned-by-client-a';
  const SUBJECT_ENTITY_ID = 'e-subject-of-client-a';

  function buildService() {
    const entities = [
      { id: OWNED_ENTITY_ID, tenantId: T, assignedTo: 'client-a' },
      { id: 'e-owned-by-someone-else', tenantId: T, assignedTo: 'client-c' },
      // An applicant is never the assignee of their own matter — a staff member
      // is. They own it by being its subject, which is the path that was broken.
      {
        id: SUBJECT_ENTITY_ID,
        tenantId: T,
        assignedTo: 'staff-9',
        subjectEmail: 'a@example.test',
      },
    ];

    const instances = [
      // Started by the client directly — owned via `startedBy`.
      {
        id: 'inst-started-by-client',
        tenantId: T,
        status: InstanceStatus.ACTIVE,
        entityId: null,
        startedBy: 'client-a',
        createdAt: new Date('2026-01-01'),
      },
      // Staff started it, but it is linked to a CRM record assigned to the
      // client — owned via `entityId` against `ownedEntityIds`. This is the
      // more common real case: staff opens the matter, the applicant tracks it.
      {
        id: 'inst-linked-to-clients-entity',
        tenantId: T,
        status: InstanceStatus.ACTIVE,
        entityId: OWNED_ENTITY_ID,
        startedBy: 'staff-2',
        createdAt: new Date('2026-01-02'),
      },
      // Staff's own matter — neither started by, nor linked to, client-a.
      {
        id: 'inst-not-clients',
        tenantId: T,
        status: InstanceStatus.COMPLETED,
        entityId: 'e-owned-by-someone-else',
        startedBy: 'staff-2',
        createdAt: new Date('2026-01-03'),
      },
      // Staff started it and staff is the assignee, but the applicant is the
      // record's SUBJECT. Before subject-ownership this matter was invisible to
      // the very person it is about.
      {
        id: 'inst-linked-to-subject-entity',
        tenantId: T,
        status: InstanceStatus.ACTIVE,
        entityId: SUBJECT_ENTITY_ID,
        startedBy: 'staff-2',
        createdAt: new Date('2026-01-05'),
      },
      // A different tenant entirely — must never surface for any T actor.
      {
        id: 'inst-other-tenant',
        tenantId: OTHER_T,
        status: InstanceStatus.ACTIVE,
        entityId: null,
        startedBy: 'client-a',
        createdAt: new Date('2026-01-04'),
      },
    ];

    function conditionMatches(inst: (typeof instances)[number], cond: any): boolean {
      if (cond.tenantId !== undefined && inst.tenantId !== cond.tenantId) return false;
      if (cond.status !== undefined && inst.status !== cond.status) return false;
      if (cond.startedBy !== undefined && inst.startedBy !== cond.startedBy) return false;
      if (cond.entityId !== undefined) {
        const entityIdCond = cond.entityId;
        // TypeORM's `In([...])` FindOperator, matched the same way the
        // existing fake repos in this codebase do (see crm-authz.spec.ts).
        if (entityIdCond && typeof entityIdCond === 'object' && '_value' in entityIdCond) {
          if (!entityIdCond._value.includes(inst.entityId)) return false;
        } else if (inst.entityId !== entityIdCond) {
          return false;
        }
      }
      return true;
    }

    const instanceRepo = {
      find: async ({ where }: any) => {
        const conditions = Array.isArray(where) ? where : [where];
        return instances.filter((inst) =>
          conditions.some((cond) => conditionMatches(inst, cond)),
        );
      },
    };

    // `ownedEntityIds` builds a query rather than calling `find`, because it has
    // to OR assignment against subject email. The stub records the bound
    // parameters and resolves rows the way the SQL would.
    const entityRepo = {
      createQueryBuilder: () => {
        const params: Record<string, any> = {};
        const bind = (_sql: string, p: Record<string, any> = {}) => {
          Object.assign(params, p);
          return qb;
        };
        const qb: any = {
          select: () => qb,
          where: bind,
          andWhere: bind,
          getRawMany: async () =>
            entities
              .filter(
                (e: any) =>
                  e.tenantId === params.tenantId &&
                  (e.assignedTo === params.userId ||
                    (!!params.email &&
                      (e.subjectEmail ?? '').trim().toLowerCase() ===
                        params.email)),
              )
              .map((e: any) => ({ id: e.id })),
        };
        return qb;
      },
    };

    const unused = {} as any;
    const service = new WorkflowEngineService(
      unused, // workflowRepo
      unused, // stateRepo
      unused, // transitionRepo
      instanceRepo as any,
      entityRepo as any,
      unused, // dataSource
      unused, // searchService
      unused, // aiService
      unused, // documentHubService
      unused, // notificationsService
      unused, // taskService
      unused, // feeScheduleService
      unused, // rules
    );

    return service;
  }

  it('staff and firm_admin see every instance in the tenant', async () => {
    const service = buildService();

    for (const key of ['firm_admin', 'staff'] as const) {
      const result = await service.listInstances(T, ACTORS[key]);
      expect(result.map((r) => r.id).sort()).toEqual(
        [
          'inst-linked-to-clients-entity',
          'inst-linked-to-subject-entity',
          'inst-not-clients',
          'inst-started-by-client',
        ].sort(),
      );
    }
  });

  it('a client sees only the matters they started or that are linked to their own CRM record', async () => {
    const service = buildService();

    const result = await service.listInstances(T, ACTORS['client-own']);
    expect(result.map((r) => r.id).sort()).toEqual(
      ['inst-linked-to-clients-entity', 'inst-started-by-client'].sort(),
    );
  });

  it('a client sees the matter they are the SUBJECT of, though staff is its assignee', async () => {
    const service = buildService();

    const withEmail = { ...ACTORS['client-own'], email: 'a@example.test' };
    const result = await service.listInstances(T, withEmail);
    expect(result.map((r) => r.id).sort()).toEqual(
      [
        'inst-linked-to-clients-entity',
        'inst-linked-to-subject-entity',
        'inst-started-by-client',
      ].sort(),
    );
  });

  it('an actor with no email falls back to assignment only — fails closed', async () => {
    const service = buildService();

    const result = await service.listInstances(T, ACTORS['client-own']);
    expect(result.map((r) => r.id)).not.toContain('inst-linked-to-subject-entity');
  });

  it('a client with no matters of their own sees an empty list, not an error', async () => {
    const service = buildService();

    const result = await service.listInstances(T, ACTORS['client-other']);
    expect(result).toEqual([]);
  });

  it('never returns another tenant\'s instances, for any actor', async () => {
    const service = buildService();

    for (const key of Object.keys(ACTORS) as (keyof typeof ACTORS)[]) {
      const result = await service.listInstances(T, ACTORS[key]);
      expect(result.every((r) => r.tenantId === T)).toBe(true);
    }
  });

  it('an explicit entityId filter cannot be used to probe a matter that is not the caller\'s', async () => {
    const service = buildService();

    // client-a asks for the OTHER applicant's linked instance by id directly.
    const result = await service.listInstances(
      T,
      ACTORS['client-own'],
      undefined,
      'e-owned-by-someone-else',
    );
    expect(result).toEqual([]);

    // Staff asking for the same filter gets the real answer.
    const staffResult = await service.listInstances(
      T,
      ACTORS['staff'],
      undefined,
      'e-owned-by-someone-else',
    );
    expect(staffResult.map((r) => r.id)).toEqual(['inst-not-clients']);
  });

  it('status filter composes with own-scope narrowing', async () => {
    const service = buildService();

    const result = await service.listInstances(
      T,
      ACTORS['client-own'],
      InstanceStatus.ACTIVE,
    );
    expect(result.map((r) => r.id).sort()).toEqual(
      ['inst-linked-to-clients-entity', 'inst-started-by-client'].sort(),
    );
  });
});
