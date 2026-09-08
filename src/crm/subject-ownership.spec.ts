import { CrmAccessService } from './crm-access.service';
import {
  EntityType,
  EntityStatus,
  UniversalEntity,
} from './entities/universal-entity.entity';
import { Actor } from '../common/access';

/**
 * Ownership by SUBJECT — the half of the model that did not exist.
 *
 * Every path deciding "is this record this caller's" resolved ownership as
 * `entity.assignedTo === actor.id`. `assignedTo` is the STAFF owner, and an
 * applicant is never the assignee of their own case, so a client matched
 * nothing anywhere: an empty case list, a 404 opening a case by id, every
 * document on that case refused, and no workflow instance for their own
 * matter. Four independent places, one wrong test.
 *
 * Nothing caught it because nothing could: minting a client account needs an
 * invite email, which needs `RESEND_API_KEY`, which is unset — so the eight
 * client-role rows of the CRUD suite have never run, and
 * `scripts/smoke/cross-tenant.sh`'s intra-tenant section is SKIPped for the
 * same reason. The credential gap was not merely delaying the test; it was
 * concealing the defect.
 *
 * This suite exists so that stays closed without a live client account. It is
 * deliberately separate from `crm-authz.spec.ts`: that file pins the matrix of
 * scope × action × ownership, and its client fixtures carry no email at all —
 * so it would pass unchanged whether or not subject ownership works. This one
 * pins the *definition of ownership itself*.
 *
 * Unit-level, so the same caveat as its sibling applies: it proves the seam is
 * correct, not that every caller uses it.
 */
describe('ownership by subject', () => {
  const T = 't1';
  const access = new CrmAccessService();

  const STAFF: Actor = { id: 'staff-1', roles: ['staff'] };
  const APPLICANT: Actor = {
    id: 'client-a',
    roles: ['client'],
    email: 'Applicant@Example.com ',
  };
  const OTHER_CLIENT: Actor = {
    id: 'client-b',
    roles: ['client'],
    email: 'someone.else@example.com',
  };
  /** A client-role token with no email — a shape the type permits. */
  const EMAILLESS_CLIENT: Actor = { id: 'client-c', roles: ['client'] };

  function entity(over: Partial<UniversalEntity> = {}): UniversalEntity {
    return {
      id: 'case-1',
      tenantId: T,
      type: EntityType.CASE,
      status: EntityStatus.OPEN,
      assignedTo: STAFF.id,
      subjectEmail: 'applicant@example.com',
      verticalAttributes: {},
      metadata: {},
      relationships: [],
      ...over,
    } as UniversalEntity;
  }

  describe('a client reaches the record they are the subject of', () => {
    it('matches on subject email', () => {
      expect(access.canAccess(entity(), APPLICANT, 'read')).toBe(true);
    });

    it('matches case-insensitively and ignores surrounding whitespace', () => {
      // The stored value comes from a form; the compared value comes from a
      // JWT. "Applicant@Example.com " and "applicant@example.com" are one
      // person, and a case-sensitive compare would lock them out of their own
      // file with no error anyone could see.
      expect(
        access.canAccess(
          entity({ subjectEmail: '  APPLICANT@example.COM' }),
          APPLICANT,
          'read',
        ),
      ).toBe(true);
    });

    it('still lets staff through by assignment', () => {
      // The original sense of ownership has to keep working: this is additive,
      // not a replacement.
      expect(
        access.canAccess(entity({ subjectEmail: null }), STAFF, 'read'),
      ).toBe(true);
    });
  });

  describe('and reaches nothing else', () => {
    it('refuses another applicant’s record', () => {
      expect(access.canAccess(entity(), OTHER_CLIENT, 'read')).toBe(false);
    });

    it('refuses when the actor has no email — fails closed', () => {
      // The field is optional on `Actor`, so this shape compiles. An absent
      // identity must never widen access.
      expect(access.canAccess(entity(), EMAILLESS_CLIENT, 'read')).toBe(false);
    });

    it('refuses when the record has no subject — NULL never matches NULL', () => {
      expect(
        access.canAccess(entity({ subjectEmail: null }), APPLICANT, 'read'),
      ).toBe(false);
    });

    it('refuses when both sides are empty strings', () => {
      // The one that would quietly hand every unsubjected record to every
      // client whose token carried a blank email.
      expect(
        access.canAccess(entity({ subjectEmail: '   ' }), {
          id: 'client-d',
          roles: ['client'],
          email: '  ',
        }),
      ).toBe(false);
    });

    it('refuses a write even on their own record', () => {
      // `own` scope is read-only by design: a client changes things through
      // named routes (acceptance, a workflow transition), never a generic
      // PATCH, or they could mark their own case lodged.
      expect(access.canAccess(entity(), APPLICANT, 'write')).toBe(false);
      expect(access.canAccess(entity(), APPLICANT, 'delete')).toBe(false);
    });
  });

  describe('tenancy is not weakened by matching on email', () => {
    it('two tenants sharing an applicant address stay separate', () => {
      // Email is not unique across tenants — the same person can be a client
      // of two firms. This check is only ever reached after the record has
      // been fetched by `{ id, tenantId }`, so the guarantee is structural
      // rather than something this comparison enforces. Pinned here so nobody
      // later "optimises" the tenant predicate away on the grounds that the
      // email match looks sufficient.
      const otherTenantsRecord = entity({ tenantId: 't2' });
      expect(access.canAccess(otherTenantsRecord, APPLICANT, 'read')).toBe(
        true,
      );
      // ...which is exactly why the caller must never hand this method a row
      // it did not scope by tenant first.
    });
  });
});
