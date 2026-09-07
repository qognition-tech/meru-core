import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CrmAccessService } from './crm-access.service';
import { UniversalEntity } from './entities/universal-entity.entity';
import { TenantContext } from '../core/tenancy/tenant-context';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { SYSTEM_ACTOR } from '../common/access';

/**
 * This is the fifth instance of the same bug shape (see the class doc
 * comment): a route scoped by tenant but reachable, by any `client` token
 * that knew or guessed a UUID, into another applicant's record. RLS isolates
 * tenants, not users inside one — these tests pin the one thing that does.
 *
 * Exhaustive over scope (god/tenant/own) x action (read/write/delete) x
 * ownership (assigned to actor / assigned to someone else / unassigned),
 * because a route added later without going through `assert` fails silently,
 * not loudly — the whole point of collapsing this into one seam.
 */
describe('CrmAccessService', () => {
  const staff = { id: 'staff-1', roles: [PlatformRole.STAFF] };
  const admin = { id: 'admin-1', roles: [PlatformRole.FIRM_ADMIN] };
  const clientA = { id: 'client-a', roles: [PlatformRole.CLIENT] };
  const clientB = { id: 'client-b', roles: [PlatformRole.CLIENT] };
  const bareOperator = { id: 'op-1', roles: [PlatformRole.PLATFORM_ADMIN] };

  const entity = (over: Record<string, unknown> = {}) =>
    ({
      id: 'entity-1',
      tenantId: 't1',
      assignedTo: 'client-a',
      ...over,
    }) as UniversalEntity;

  const service = () => new CrmAccessService();

  describe('scopeOf', () => {
    it('resolves firm_admin and staff to tenant scope', () => {
      const s = service();
      expect(s.scopeOf(staff)).toBe('tenant');
      expect(s.scopeOf(admin)).toBe('tenant');
    });

    it('resolves a client to own scope', () => {
      expect(service().scopeOf(clientA)).toBe('own');
    });

    it('resolves a bare platform_admin to own scope, not tenant or god', () => {
      // A bare token is a claim about who someone is, not a record that they
      // looked. Operator reach is the audited runAsGod path, and only that.
      expect(service().scopeOf(bareOperator)).toBe('own');
    });

    it('resolves to god scope only inside runAsGod', async () => {
      const s = service();
      await TenantContext.runAsGod('op-1', 'test', async () => {
        expect(s.scopeOf(bareOperator)).toBe('god');
      });
      // Outside the callback the same actor is back to own scope.
      expect(s.scopeOf(bareOperator)).toBe('own');
    });

    it('runAsSystem is NOT god scope — a system bypass does not widen a user', async () => {
      const s = service();
      await TenantContext.runAsSystem('test', async () => {
        expect(s.scopeOf(clientA)).toBe('own');
      });
    });

    it('a client who also holds staff resolves to tenant scope — the wider role wins', () => {
      const dual = { id: 'dual-1', roles: [PlatformRole.CLIENT, PlatformRole.STAFF] };
      expect(service().scopeOf(dual)).toBe('tenant');
    });

    it('SYSTEM_ACTOR resolves to tenant scope', () => {
      expect(service().scopeOf(SYSTEM_ACTOR)).toBe('tenant');
    });
  });

  describe('ownsEntity', () => {
    it('is true when assignedTo matches the actor', () => {
      expect(service().ownsEntity(entity({ assignedTo: 'client-a' }), clientA)).toBe(true);
    });

    it('is false when assignedTo names someone else', () => {
      expect(service().ownsEntity(entity({ assignedTo: 'client-b' }), clientA)).toBe(false);
    });

    it('is false when assignedTo is null — an unassigned record matches no one', () => {
      expect(service().ownsEntity(entity({ assignedTo: null }), clientA)).toBe(false);
    });

    it('is false when assignedTo is undefined', () => {
      expect(service().ownsEntity(entity({ assignedTo: undefined }), clientA)).toBe(false);
    });

    it('is false for an actor with a null/undefined id — never matches a null assignedTo', () => {
      const s = service();
      const ghost = { id: undefined as unknown as string, roles: [PlatformRole.CLIENT] };
      expect(s.ownsEntity(entity({ assignedTo: null }), ghost)).toBe(false);
      expect(s.ownsEntity(entity({ assignedTo: undefined }), ghost)).toBe(false);
      // Guards specifically against `!!entity.assignedTo && entity.assignedTo === actor.id`
      // degrading to `undefined === undefined` if the falsy guard were ever dropped.
      expect(s.ownsEntity(entity({ assignedTo: undefined as unknown as string }), ghost)).toBe(false);
    });
  });

  describe('canAccess — god scope', () => {
    it('reads, writes and deletes anything, regardless of ownership', async () => {
      const s = service();
      await TenantContext.runAsGod('op-1', 'test', async () => {
        const other = entity({ assignedTo: 'client-b' });
        expect(s.canAccess(other, bareOperator, 'read')).toBe(true);
        expect(s.canAccess(other, bareOperator, 'write')).toBe(true);
        expect(s.canAccess(other, bareOperator, 'delete')).toBe(true);
      });
    });
  });

  describe('canAccess — tenant scope (firm_admin / staff)', () => {
    it.each(['read', 'write', 'delete'] as const)(
      'may %s any record in the tenant, owned or not',
      (action) => {
        const s = service();
        expect(s.canAccess(entity({ assignedTo: 'client-b' }), staff, action)).toBe(true);
        expect(s.canAccess(entity({ assignedTo: null }), admin, action)).toBe(true);
      },
    );
  });

  describe('canAccess — own scope (client, bare platform_admin)', () => {
    it('reads a record assigned to them', () => {
      expect(service().canAccess(entity({ assignedTo: 'client-a' }), clientA, 'read')).toBe(true);
    });

    it('cannot read a record assigned to someone else', () => {
      expect(service().canAccess(entity({ assignedTo: 'client-b' }), clientA, 'read')).toBe(false);
    });

    it('cannot read an unassigned record', () => {
      expect(service().canAccess(entity({ assignedTo: null }), clientA, 'read')).toBe(false);
    });

    it.each(['write', 'delete'] as const)(
      'cannot %s even a record assigned to them — the generic write path is staff/god only',
      (action) => {
        expect(service().canAccess(entity({ assignedTo: 'client-a' }), clientA, action)).toBe(false);
      },
    );

    it('a bare platform_admin follows the exact same rules as a client', () => {
      const s = service();
      const own = entity({ assignedTo: 'op-1' });
      const notOwn = entity({ assignedTo: 'client-a' });
      expect(s.canAccess(own, bareOperator, 'read')).toBe(true);
      expect(s.canAccess(own, bareOperator, 'write')).toBe(false);
      expect(s.canAccess(notOwn, bareOperator, 'read')).toBe(false);
    });
  });

  describe('assert — the shape of the refusal', () => {
    it('own scope, not the owner, read: 404 not 403', () => {
      // A 403 confirms the id exists. Entity ids travel in checklists and
      // email links, so "real but not yours" is itself a disclosure — this
      // is the whole reason `assert` exists rather than a bare boolean.
      const s = service();
      const other = entity({ assignedTo: 'client-b' });
      expect(() => s.assert(other, clientA, 'read')).toThrow(NotFoundException);
      expect(() => s.assert(other, clientA, 'read')).not.toThrow(ForbiddenException);
    });

    it('own scope, the owner, write: 403 not 404 — readable but not writable', () => {
      const s = service();
      const mine = entity({ assignedTo: 'client-a' });
      expect(() => s.assert(mine, clientA, 'write')).toThrow(ForbiddenException);
      expect(() => s.assert(mine, clientA, 'write')).not.toThrow(NotFoundException);
    });

    it('own scope, the owner, delete: 403 not 404', () => {
      const s = service();
      const mine = entity({ assignedTo: 'client-a' });
      expect(() => s.assert(mine, clientA, 'delete')).toThrow(ForbiddenException);
    });

    it('own scope, unassigned record, read: 404', () => {
      const s = service();
      expect(() => s.assert(entity({ assignedTo: null }), clientA, 'read')).toThrow(
        NotFoundException,
      );
    });

    it('tenant scope: never throws, any action, any ownership', () => {
      const s = service();
      const other = entity({ assignedTo: 'client-b' });
      expect(() => s.assert(other, staff, 'read')).not.toThrow();
      expect(() => s.assert(other, staff, 'write')).not.toThrow();
      expect(() => s.assert(other, staff, 'delete')).not.toThrow();
    });

    it('god scope: never throws, any action, any ownership', async () => {
      const s = service();
      await TenantContext.runAsGod('op-1', 'test', async () => {
        const other = entity({ assignedTo: 'client-b' });
        expect(() => s.assert(other, bareOperator, 'delete')).not.toThrow();
      });
    });
  });

  describe('applyScope', () => {
    // Dead code today (see the method's own doc comment) — nothing calls
    // this yet. Tested anyway, because the bug it once had (`assignedTo`
    // alone) is exactly the one this whole file exists to close, and a
    // future caller wiring it must not reintroduce it silently.
    it('narrows to assignedTo alone when the actor has no email', () => {
      const s = service();
      const qb = { andWhere: jest.fn() };
      const noEmail = { id: 'client-a', roles: [PlatformRole.CLIENT] };
      s.applyScope(qb as any, noEmail, 'entity');
      expect(qb.andWhere).toHaveBeenCalledWith('entity."assignedTo" = :crmActorId', {
        crmActorId: 'client-a',
      });
    });

    it('ORs in subjectEmail for own scope, matching ownsEntity', () => {
      const s = service();
      const qb = { andWhere: jest.fn() };
      const withEmail = {
        id: 'client-a',
        roles: [PlatformRole.CLIENT],
        email: 'Applicant@Example.com ',
      };
      s.applyScope(qb as any, withEmail, 'entity');
      // Lower-cased and trimmed, matching how `subjectEmail` is normalised
      // on write and how `ownsEntity` compares it.
      expect(qb.andWhere).toHaveBeenCalledWith(
        '(entity."assignedTo" = :crmActorId OR LOWER(TRIM(entity."subjectEmail")) = :crmActorEmail)',
        { crmActorId: 'client-a', crmActorEmail: 'applicant@example.com' },
      );
    });

    it('does not narrow the query for tenant or god scope', async () => {
      const s = service();
      const qbStaff = { andWhere: jest.fn() };
      s.applyScope(qbStaff as any, staff);
      expect(qbStaff.andWhere).not.toHaveBeenCalled();

      const qbGod = { andWhere: jest.fn() };
      await TenantContext.runAsGod('op-1', 'test', async () => {
        s.applyScope(qbGod as any, bareOperator);
      });
      expect(qbGod.andWhere).not.toHaveBeenCalled();
    });
  });

  describe('mayReadInternalNotes', () => {
    it('is false for own scope', () => {
      expect(service().mayReadInternalNotes(clientA)).toBe(false);
      expect(service().mayReadInternalNotes(bareOperator)).toBe(false);
    });

    it('is true for tenant scope', () => {
      expect(service().mayReadInternalNotes(staff)).toBe(true);
      expect(service().mayReadInternalNotes(admin)).toBe(true);
    });

    it('is true for god scope', async () => {
      const s = service();
      await TenantContext.runAsGod('op-1', 'test', async () => {
        expect(s.mayReadInternalNotes(bareOperator)).toBe(true);
      });
    });
  });
});
