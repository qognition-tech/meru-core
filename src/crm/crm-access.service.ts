import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { SelectQueryBuilder } from 'typeorm';
import { UniversalEntity } from './entities/universal-entity.entity';
import { Actor, AccessScope, scopeOf } from '../common/access';

export type CrmAction = 'read' | 'write' | 'delete';

/**
 * Who may see which CRM record, decided in one place.
 *
 * **This is the fifth instance of the same bug shape**, and the first one found
 * on a resource that already had the fix half-applied. `CrmController` has had
 * a private `clientScoped()` helper since `/crm/entities` was narrowed — but it
 * was only ever called from the **list** and **export** routes. Every by-id
 * route reached `CrmService.getEntity(id, tenantId)` / `updateEntity(...)`,
 * neither of which takes an actor at all, so a `client` token that knew or
 * guessed a UUID could read *and modify* any other applicant's case: their
 * status, their stage, their assignee, their `verticalAttributes` — which on
 * ImmiStack is where passport and visa data lives.
 *
 * RLS does not help. It isolates tenants, not users inside one.
 *
 * **Ownership has two senses and both are load-bearing.** Staff own by
 * assignment. An applicant owns by being the record's SUBJECT — they are never
 * the assignee of their own case, a staff member is. This class read
 * `assignedTo` alone, and the row below used to say "records assigned to them",
 * which meant a client matched nothing at all: the client portal rendered "no
 * case yet" to every applicant. The same wrong test appeared in four places
 * (here, `CrmController.clientScoped`, `DocumentAccessService` and
 * `WorkflowService`) and all four now compare `subjectEmail` as well.
 *
 * | Caller                 | May read                    | May write / delete   |
 * |------------------------|-----------------------------|----------------------|
 * | inside `runAsGod`      | anything (already audited)  | anything             |
 * | `firm_admin` / `staff` | anything in their tenant    | anything in tenant   |
 * | `client`               | records they are the SUBJECT of, or that are |
 * |                        | assigned to them            | **nothing**          |
 * | bare `platform_admin`  | as above                    | nothing — god path   |
 *
 * ## Why `own` scope is read-only
 *
 * A client legitimately *does* change things — they approve a draft, they
 * accept a cost agreement, they upload a document. None of that is a generic
 * `PATCH /crm/entities/:id`. Those go through purpose-built routes that carry
 * their own meaning and their own audit trail:
 * `POST /crm/entities/:id/acceptance` records assent with a SHA-256 of the
 * exact bytes shown; a stage change is a workflow transition. Letting a client
 * PATCH the record directly would let them rewrite `status`, `assignedTo` or
 * `stage` — reassigning their own matter, or marking it lodged.
 *
 * So: read through this service, write through a named route.
 *
 * ## Ownership is `assignedTo`, and that is not a free choice
 *
 * `DocumentAccessService.ownedEntityIds` already resolves a client's records by
 * `assignedTo`, and says in its own comment that the two must keep reading the
 * same field or "a client sees a case in one place and not the other". This
 * service is bound by that invariant: changing the ownership model here means
 * changing it there in the same commit.
 *
 * **Known limitation, deliberately not guessed at.** A visa matter with a
 * co-applicant or a dependent child has exactly one `assignedTo`, so a second
 * person entitled to see that matter would receive a 404. No relation type in
 * the immigration pack currently designates such a person, so widening this
 * would be inventing a model rather than enforcing one. If co-applicant access
 * is required, add the relation to the pack first, then widen
 * {@link ownsEntity} and `DocumentAccessService.ownedEntityIds` together.
 */
@Injectable()
export class CrmAccessService {
  scopeOf(actor: Actor): AccessScope {
    return scopeOf(actor);
  }

  /**
   * The single ownership predicate.
   *
   * Every route that asks "is this record theirs?" comes through here, so
   * widening the ownership model is one edit in one place rather than fifteen
   * call sites that drifted apart.
   */
  ownsEntity(entity: UniversalEntity, actor: Actor): boolean {
    // Two different senses of "owns", and both are needed.
    //
    // Staff own by assignment. An applicant owns by being the SUBJECT: they
    // are never the assignee of their own case — a staff member is — so
    // comparing user ids answered "no" for every client on every record. That
    // is the same defect that made `CrmController.clientScoped` return an
    // empty list, and fixing only the list would have left the by-id read
    // 404ing on a case the client can see in their own portal.
    //
    // Compared lower-cased and trimmed, matching how `subjectEmail` is
    // normalised on write and filtered on read. An actor with no email never
    // matches, which fails closed.
    if (entity.assignedTo && entity.assignedTo === actor.id) return true;

    const actorEmail = actor.email?.trim().toLowerCase();
    const subject = entity.subjectEmail?.trim().toLowerCase();
    return !!actorEmail && !!subject && actorEmail === subject;
  }

  /** Does this caller reach this record at all? */
  canAccess(
    entity: UniversalEntity,
    actor: Actor,
    action: CrmAction = 'read',
  ): boolean {
    const scope = this.scopeOf(actor);
    if (scope === 'god' || scope === 'tenant') return true;

    // `own` scope: read their own record, change nothing generically.
    if (action !== 'read') return false;
    return this.ownsEntity(entity, actor);
  }

  /**
   * Refuse, in the shape that leaks least.
   *
   * A record the caller may not read is **404, not 403**, matching
   * `/payments/:id`, `/documents/:id` and `/communications/threads`. A 403
   * confirms the id exists, and entity ids travel in checklists, email links
   * and export files — "this one is real but not yours" is itself a
   * disclosure, and it turns id enumeration into a census of the firm's
   * caseload.
   *
   * A record they may read but not change is a genuine 403: it reveals nothing
   * they cannot already see.
   */
  assert(
    entity: UniversalEntity,
    actor: Actor,
    action: CrmAction = 'read',
  ): void {
    if (this.canAccess(entity, actor, action)) return;

    if (!this.canAccess(entity, actor, 'read')) {
      throw new NotFoundException('Entity not found');
    }

    throw new ForbiddenException(
      `You do not have ${action} permission for this record`,
    );
  }

  /**
   * Narrow a list query to what the caller may see.
   *
   * Applied in the service so every route built on the query inherits it. The
   * controller's own `clientScoped()` does this for the list and export routes
   * by rewriting the query DTO; this is the same rule expressed where it cannot
   * be forgotten.
   */
  applyScope(
    qb: SelectQueryBuilder<UniversalEntity>,
    actor: Actor,
    alias = 'entity',
  ): void {
    if (this.scopeOf(actor) !== 'own') return;
    qb.andWhere(`${alias}."assignedTo" = :crmActorId`, { crmActorId: actor.id });
  }

  /**
   * May this caller see staff-internal notes on a record?
   *
   * Never for `own` scope, and this is deliberately **not** a default a caller
   * can override. `GET /crm/entities/:id/comments?includeInternal=true` read
   * that flag straight off the query string with no role check, so a client
   * could ask for — and receive — the firm's private file notes on any case.
   * The route's own description said internal notes are "withheld unless
   * `includeInternal=true` is asked for explicitly", which defended the default
   * and not the answer.
   */
  mayReadInternalNotes(actor: Actor): boolean {
    return this.scopeOf(actor) !== 'own';
  }
}
