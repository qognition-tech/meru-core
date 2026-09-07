import { NotFoundException } from '@nestjs/common';
import { DocumentChecklistService } from './document-checklist.service';
import { DocumentAccessService } from './document-access.service';
import type { Actor } from '../common/access';

/**
 * `GET /documents/checklist?entityId=` called `forEntity` with no actor at
 * all, and `forEntity` filtered the named entity on `{ id: entityId,
 * tenantId }` only. Any client could pass another applicant's case id and
 * receive that applicant's checklist — document names, ids and upload
 * status — because RLS confines the query to the tenant, not to the caller
 * inside it.
 *
 * Same construction style as `document-access.service.spec.ts`: services
 * built directly, `DocumentAccessService` given a hand-rolled
 * `UniversalEntity` repo stub that answers the same assignment/subject query
 * the real SQL would.
 */
describe('DocumentChecklistService.forEntity — GET /documents/checklist?entityId=', () => {
  const T = 'tenant-1';
  const OWNED_CASE = 'case-owned';
  const FOREIGN_CASE = 'case-foreign';

  const staff: Actor = { id: 'staff-1', roles: ['staff'] };
  const clientA: Actor = {
    id: 'client-a',
    roles: ['client'],
    email: 'a@example.test',
  };

  // client-a is the SUBJECT of OWNED_CASE, never its assignee — an applicant
  // owns a case by being about it, matching CrmAccessService/DocumentAccessService.
  const assignments: Record<string, string[]> = {};
  const subjects: Record<string, string[]> = {
    'a@example.test': [OWNED_CASE],
  };

  function build() {
    const entitiesForAccess = {
      createQueryBuilder: jest.fn(() => {
        const params: Record<string, any> = {};
        const bind = (_sql: string, p: Record<string, any> = {}) => {
          Object.assign(params, p);
          return qb;
        };
        const qb: any = {
          select: () => qb,
          where: bind,
          andWhere: bind,
          getRawMany: async () => {
            const ids = new Set<string>(assignments[params.userId] ?? []);
            if (params.email) {
              for (const id of subjects[params.email] ?? []) ids.add(id);
            }
            return [...ids].map((id) => ({ id }));
          },
        };
        return qb;
      }),
    };
    const access = new DocumentAccessService(entitiesForAccess as any);

    const packs = {
      sectionWithPack: jest.fn(async () => ({
        pack: { code: 'test-pack', version: '1.0.0' },
        section: [{ key: 'passport', label: 'Passport', required: true }],
      })),
    };

    const documentRepo = { find: jest.fn(async () => []) };

    const entityRepo = {
      findOne: jest.fn(async ({ where }: any) => {
        if (where.id === OWNED_CASE && where.tenantId === T) {
          return {
            id: OWNED_CASE,
            tenantId: T,
            type: 'case',
            status: 'open',
            verticalAttributes: {},
          };
        }
        if (where.id === FOREIGN_CASE && where.tenantId === T) {
          return {
            id: FOREIGN_CASE,
            tenantId: T,
            type: 'case',
            status: 'open',
            verticalAttributes: {},
          };
        }
        return null;
      }),
    };

    const rules = { matches: jest.fn(() => true) };

    const service = new DocumentChecklistService(
      packs as any,
      documentRepo as any,
      entityRepo as any,
      rules as any,
      access,
    );

    return { service, entityRepo, documentRepo };
  }

  it('refuses a client reading the checklist for a case that is not theirs, 404 not 403', async () => {
    const { service, entityRepo } = build();

    await expect(
      service.forEntity(T, 'immigration', clientA, FOREIGN_CASE),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Refused before the entity — and therefore its documents — was ever loaded.
    expect(entityRepo.findOne).not.toHaveBeenCalled();
  });

  it('allows a client to read the checklist for their own case', async () => {
    const { service } = build();

    const result = await service.forEntity(T, 'immigration', clientA, OWNED_CASE);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].key).toBe('passport');
  });

  it('allows staff to read the checklist for any case in the tenant', async () => {
    const { service } = build();

    const result = await service.forEntity(T, 'immigration', staff, FOREIGN_CASE);

    expect(result.items).toHaveLength(1);
  });

  it('a client asking with no entityId still gets the bare requirement list', async () => {
    const { service } = build();

    // Nothing to own-check when no entity is named — this must not throw,
    // and `uploaded` stays null ("not asked"), never false ("missing").
    const result = await service.forEntity(T, 'immigration', clientA);

    expect(result.items[0].uploaded).toBeNull();
  });
});
