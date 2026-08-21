import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { Document } from './entities/document.entity';
import { UniversalEntity } from '../crm/entities/universal-entity.entity';
import { Actor, AccessScope, scopeOf } from '../common/access';

export type DocumentAction = 'read' | 'write' | 'delete' | 'share';

/**
 * Who may see which document, decided in one place.
 *
 * **This is the fourth instance of the same bug shape.** `/crm/entities`,
 * `/payments` and `/communications/threads` each reached production
 * tenant-scoped but not user-scoped, because RLS isolates tenants and nothing
 * isolates users inside one. Documents were the worst of the four:
 * `DocumentHubService.canAccessDocument` ended in `return true; // Simplified
 * for now`, so on ImmiStack one visa applicant could read another applicant's
 * passport, and `GET /documents` listed every document in the firm to any
 * authenticated token.
 *
 * The opposite failure was live at the same time and is the reason this service
 * owns both directions: `DocumentsService.checkAccess` allowed *only* the
 * uploader, so a caseworker could not open a document their own client had
 * uploaded. One rule, one place, both answers correct:
 *
 * | Caller                          | May read                                    |
 * |---------------------------------|---------------------------------------------|
 * | inside `runAsGod`               | anything (already audited)                   |
 * | `firm_admin` / `staff`          | anything in their tenant                     |
 * | `client`                        | what they uploaded, plus documents linked to |
 * |                                 | a CRM record assigned to them                |
 * | bare `platform_admin`           | what they uploaded — operator reach is the   |
 * |                                 | god path, see `isGodContext`                 |
 *
 * Write, delete and share are narrower than read on purpose: a client whose
 * case file is visible to them must not be able to delete the firm's copy of a
 * decision letter. Those actions need the uploader or staff.
 */
@Injectable()
export class DocumentAccessService {
  constructor(
    @InjectRepository(UniversalEntity)
    private readonly entities: Repository<UniversalEntity>,
  ) {}

  scopeOf(actor: Actor): AccessScope {
    return scopeOf(actor);
  }

  /**
   * The CRM records a client owns, as ids.
   *
   * Ownership is `assignedTo`, the same column `/crm/entities` confines a
   * client to. If the two ever disagree a client sees a case in one place and
   * not the other, so they must keep reading the same field.
   */
  private async ownedEntityIds(
    tenantId: string,
    userId: string,
  ): Promise<string[]> {
    const rows = await this.entities.find({
      where: { tenantId, assignedTo: userId },
      select: ['id'],
    });
    return rows.map((r) => r.id);
  }

  /** Does this caller reach this document at all? */
  async canAccess(
    document: Document,
    actor: Actor,
    action: DocumentAction = 'read',
  ): Promise<boolean> {
    const scope = this.scopeOf(actor);
    if (scope === 'god' || scope === 'tenant') return true;

    // The uploader owns their upload for every action. `rbac.owner` is set to
    // the uploader at creation and is checked too, because a document may be
    // handed over by rewriting it without moving `uploadedById`.
    const isOwner =
      document.uploadedById === actor.id || document.rbac?.owner === actor.id;
    if (isOwner) return true;

    // Beyond that a client may only *read*, and only their own case file.
    if (action !== 'read') return false;

    if (!document.linkedEntityId) return false;
    const owned = await this.ownedEntityIds(document.tenantId, actor.id);
    return owned.includes(document.linkedEntityId);
  }

  /**
   * Refuse, in the shape that leaks least.
   *
   * A document the caller may not read is reported as **404, not 403** — the
   * same choice `/payments/:id` and `/communications/threads` made. A 403
   * confirms the id exists, and document ids are handed out in checklists and
   * email links, so "this one is real but not yours" is itself a disclosure.
   *
   * A document they may read but not change is a genuine 403: nothing is
   * revealed that they cannot already see.
   */
  async assert(
    document: Document,
    actor: Actor,
    action: DocumentAction = 'read',
  ): Promise<void> {
    if (await this.canAccess(document, actor, action)) return;

    if (!(await this.canAccess(document, actor, 'read'))) {
      throw new NotFoundException('Document not found');
    }

    throw new ForbiddenException(
      `You do not have ${action} permission for this document`,
    );
  }

  /**
   * Narrow a list query to what the caller may see.
   *
   * Applied in the service, so the list and every route built on it inherit it.
   * Without this `GET /documents` returned the firm's entire document table to
   * a client token — names, file types and linked case ids for every other
   * applicant, and the ids are all a caller needs to try `/documents/:id`.
   */
  async applyScope(
    qb: SelectQueryBuilder<Document>,
    tenantId: string,
    actor: Actor,
    alias = 'document',
  ): Promise<void> {
    if (this.scopeOf(actor) !== 'own') return;

    const owned = await this.ownedEntityIds(tenantId, actor.id);

    if (owned.length === 0) {
      qb.andWhere(`${alias}.uploadedById = :actorId`, { actorId: actor.id });
      return;
    }

    qb.andWhere(
      `(${alias}.uploadedById = :actorId OR ${alias}.linkedEntityId IN (:...ownedEntityIds))`,
      { actorId: actor.id, ownedEntityIds: owned },
    );
  }
}
