import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DocumentAccessService } from './document-access.service';
import { TenantContext } from '../core/tenancy/tenant-context';
import { SYSTEM_ACTOR } from '../common/access';

/**
 * RLS isolates tenants, not users inside one. These tests pin the only thing
 * standing between one applicant and another applicant's passport scan.
 *
 * The shape matters as much as the answer: a document a client may not read
 * is a 404, not a 403, because document ids travel in checklists and email
 * links and "real but not yours" is itself a disclosure.
 */
describe('DocumentAccessService', () => {
  const T = 'tenant-1';
  const staff = { id: 'staff-1', roles: ['staff'] };
  const admin = { id: 'admin-1', roles: ['firm_admin'] };
  const clientA = { id: 'client-a', roles: ['client'] };
  const clientB = { id: 'client-b', roles: ['client'] };
  const bareOperator = { id: 'op-1', roles: ['platform_admin'] };

  // Which CRM records each client is `assignedTo`.
  const assignments: Record<string, string[]> = {
    'client-a': ['case-a'],
    'client-b': ['case-b'],
  };

  const doc = (over: Record<string, any> = {}) => ({
    id: 'doc-1',
    tenantId: T,
    uploadedById: 'staff-1',
    linkedEntityId: undefined,
    rbac: undefined,
    ...over,
  });

  const build = () => {
    const entities = {
      find: jest.fn(async ({ where }: any) => {
        return (assignments[where.assignedTo] ?? []).map((id) => ({ id }));
      }),
    };
    return { service: new DocumentAccessService(entities as any), entities };
  };

  describe('staff', () => {
    it('reads any document in the tenant', async () => {
      const { service } = build();
      expect(await service.canAccess(doc({ uploadedById: 'client-a' }) as any, staff)).toBe(true);
      expect(await service.canAccess(doc({ uploadedById: 'client-a' }) as any, admin)).toBe(true);
    });

    it('writes and deletes any document in the tenant', async () => {
      const { service } = build();
      const d = doc({ uploadedById: 'client-a' }) as any;
      expect(await service.canAccess(d, staff, 'write')).toBe(true);
      expect(await service.canAccess(d, staff, 'delete')).toBe(true);
    });

    it('is not narrowed by applyScope', async () => {
      const { service, entities } = build();
      const qb = { andWhere: jest.fn() };
      await service.applyScope(qb as any, T, staff);
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(entities.find).not.toHaveBeenCalled();
    });
  });

  describe('client', () => {
    it('reads their own upload', async () => {
      const { service } = build();
      expect(await service.canAccess(doc({ uploadedById: 'client-a' }) as any, clientA)).toBe(true);
    });

    it('reads a document linked to a case assigned to them', async () => {
      const { service } = build();
      const d = doc({ uploadedById: 'staff-1', linkedEntityId: 'case-a' }) as any;
      expect(await service.canAccess(d, clientA)).toBe(true);
    });

    it('cannot read another client’s upload, and gets 404 not 403', async () => {
      const { service } = build();
      const d = doc({ uploadedById: 'client-b', linkedEntityId: 'case-b' }) as any;
      expect(await service.canAccess(d, clientA)).toBe(false);
      await expect(service.assert(d, clientA)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.assert(d, clientA)).rejects.not.toBeInstanceOf(ForbiddenException);
    });

    it('cannot read an unlinked document uploaded by staff', async () => {
      const { service } = build();
      const d = doc({ uploadedById: 'staff-1' }) as any;
      await expect(service.assert(d, clientA)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('gets 403 on write to a document they can read but did not upload', async () => {
      const { service } = build();
      const d = doc({ uploadedById: 'staff-1', linkedEntityId: 'case-a' }) as any;
      expect(await service.canAccess(d, clientA, 'read')).toBe(true);
      expect(await service.canAccess(d, clientA, 'write')).toBe(false);
      await expect(service.assert(d, clientA, 'write')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.assert(d, clientA, 'delete')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('may write their own upload', async () => {
      const { service } = build();
      const d = doc({ uploadedById: 'client-a' }) as any;
      await expect(service.assert(d, clientA, 'write')).resolves.toBeUndefined();
    });

    it('is narrowed to own uploads plus assigned cases in applyScope', async () => {
      const { service } = build();
      const qb = { andWhere: jest.fn() };
      await service.applyScope(qb as any, T, clientA);
      expect(qb.andWhere).toHaveBeenCalledTimes(1);
      const [sql, params] = qb.andWhere.mock.calls[0];
      expect(sql).toContain('uploadedById = :actorId');
      expect(sql).toContain('linkedEntityId IN');
      expect(params).toEqual({ actorId: 'client-a', ownedEntityIds: ['case-a'] });
    });

    it('with no assigned cases is narrowed to own uploads only', async () => {
      const { service } = build();
      const qb = { andWhere: jest.fn() };
      await service.applyScope(qb as any, T, { id: 'nobody', roles: ['client'] });
      const [sql, params] = qb.andWhere.mock.calls[0];
      expect(sql).not.toContain('linkedEntityId');
      expect(params).toEqual({ actorId: 'nobody' });
    });

    it('a client who also holds staff is staff', async () => {
      const { service } = build();
      const both = { id: 'dual', roles: ['client', 'staff'] };
      expect(await service.canAccess(doc({ uploadedById: 'client-b' }) as any, both)).toBe(true);
    });
  });

  describe('platform operator', () => {
    it('a bare platform_admin token is scoped to own records', async () => {
      const { service } = build();
      const d = doc({ uploadedById: 'client-b' }) as any;
      expect(service.scopeOf(bareOperator)).toBe('own');
      await expect(service.assert(d, bareOperator)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('inside runAsGod bypasses every check', async () => {
      const { service } = build();
      const d = doc({ uploadedById: 'client-b' }) as any;
      await TenantContext.runAsGod('op-1', 'test', async () => {
        expect(service.scopeOf(bareOperator)).toBe('god');
        expect(await service.canAccess(d, bareOperator, 'delete')).toBe(true);
        expect(await service.canAccess(d, clientA, 'delete')).toBe(true);
      });
    });

    it('runAsSystem is NOT god: a system bypass does not widen a user', async () => {
      const { service } = build();
      const d = doc({ uploadedById: 'client-b' }) as any;
      await TenantContext.runAsSystem('test', async () => {
        expect(service.scopeOf(clientA)).toBe('own');
        expect(await service.canAccess(d, clientA)).toBe(false);
      });
    });
  });

  describe('SYSTEM_ACTOR', () => {
    it('resolves to tenant scope so internal callers see the tenant', () => {
      const { service } = build();
      expect(service.scopeOf(SYSTEM_ACTOR)).toBe('tenant');
    });
  });
});
