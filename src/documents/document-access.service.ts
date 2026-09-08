import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { Document } from './entities/document.entity';
import { UniversalEntity } from '../crm/entities/universal-entity.entity';
import { Tenant } from '../iam/entities/tenant.entity';
import { Actor, AccessScope, scopeOf } from '../common/access';
import { MeruErrorCode } from '../common/types';

/**
 * The metadata `GET /platform/tenants/:id/documents` (ADR 0009 §2.3) may
 * return — explicitly excluding `s3Url`, `rbac` and `aiAnalysis` (the last
 * may hold extracted PII text), so this shape structurally cannot become a
 * bytes path by a later careless `select: '*'`.
 */
export type DocumentMetadata = Pick<
  Document,
  | 'id'
  | 'name'
  | 'fileType'
  | 'originalFileName'
  | 'fileSize'
  | 'mimeType'
  | 'status'
  | 'linkedEntityType'
  | 'linkedEntityId'
  | 'versionNumber'
  | 'uploadedById'
  | 'createdAt'
>;

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
 * |                                 | a CRM record they are the SUBJECT of, or     |
 * |                                 | that is assigned to them                     |
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
    @InjectRepository(Document)
    private readonly documents: Repository<Document>,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
  ) {}

  scopeOf(actor: Actor): AccessScope {
    return scopeOf(actor);
  }

  /**
   * The CRM records a caller owns, as ids.
   *
   * Two senses of ownership, and both are needed — the same pair
   * `CrmAccessService.ownsEntity` uses. Staff own by assignment. An applicant
   * owns by being the record's SUBJECT: they are never the assignee of their
   * own case, a staff member is.
   *
   * This read `assignedTo` alone, and the comment that stood here said it must
   * keep reading the same field as `/crm/entities` "or a client sees a case in
   * one place and not the other". That was right, and it is why this changed:
   * `/crm/entities` now confines a client by `subjectEmail`, so a client could
   * list their case and still be refused every document attached to it.
   *
   * Email compared lower-cased and trimmed, matching how `subjectEmail` is
   * normalised on write. An actor with no email contributes nothing, so the
   * check fails closed.
   */
  private async ownedEntityIds(
    tenantId: string,
    actor: Actor,
  ): Promise<string[]> {
    const email = actor.email?.trim().toLowerCase();

    const qb = this.entities
      .createQueryBuilder('e')
      .select('e.id', 'id')
      .where('e."tenantId" = :tenantId', { tenantId });

    if (email) {
      qb.andWhere(
        '(e."assignedTo" = :userId OR LOWER(TRIM(e."subjectEmail")) = :email)',
        { userId: actor.id, email },
      );
    } else {
      qb.andWhere('e."assignedTo" = :userId', { userId: actor.id });
    }

    const rows = await qb.getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }

  /**
   * Does this caller own the CRM record named by `entityId` — the same
   * predicate `canAccess` applies via a document's `linkedEntityId`, exposed
   * directly for the two callers that need to gate on a record before any
   * `Document` row exists to check:
   *
   *  - `DocumentChecklistService.forEntity`, so `GET /documents/checklist
   *    ?entityId=` cannot be pointed at another applicant's case to read
   *    their document names, ids and upload status — it took no actor at
   *    all and filtered only on `{ id: entityId, tenantId }`.
   *  - `DocumentsService.upload` / `.create`, so a client cannot plant a
   *    document onto another applicant's case by naming its id in
   *    `dto.linkedEntityId`, which used to be written verbatim.
   *
   * `tenant`/`god` scope always passes — staff have full reach, matching
   * every other check in this file. 404, not 403, on refusal: the same
   * reasoning as `assert` — confirming a real-but-foreign entity id exists
   * is itself a disclosure.
   */
  async assertOwnsEntity(
    tenantId: string,
    entityId: string,
    actor: Actor,
  ): Promise<void> {
    if (this.scopeOf(actor) !== 'own') return;

    const owned = await this.ownedEntityIds(tenantId, actor);
    if (!owned.includes(entityId)) {
      throw new NotFoundException('Entity not found');
    }
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
    const owned = await this.ownedEntityIds(document.tenantId, actor);
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

    const owned = await this.ownedEntityIds(tenantId, actor);

    if (owned.length === 0) {
      qb.andWhere(`${alias}.uploadedById = :actorId`, { actorId: actor.id });
      return;
    }

    qb.andWhere(
      `(${alias}.uploadedById = :actorId OR ${alias}.linkedEntityId IN (:...ownedEntityIds))`,
      { actorId: actor.id, ownedEntityIds: owned },
    );
  }

  /**
   * Metadata-only document inventory for the operator console (ADR 0009
   * §2.3, `GET /platform/tenants/:id/documents`).
   *
   * A **distinct** method, not a relaxed `applyScope` or `canAccess` call —
   * deliberately, so this operator path can never be reached by accidentally
   * passing a non-god actor into the client-facing methods above, and so a
   * future change to what a `client`/`staff` actor may see cannot silently
   * also change what an operator inventory returns. The caller
   * (`PlatformDocumentsController`) is responsible for wrapping this in
   * `TenancyService.runAsGod` — this method does not itself check who is
   * asking, the same division of responsibility `getPlatformStats` and the
   * rest of the God View reads already use.
   *
   * Returns metadata only (see `DocumentMetadata`): never `s3Url`, `rbac` or
   * `aiAnalysis`. CLAUDE.md §5.1b's storage model is short-TTL signed URLs
   * only, never a public link, and an operator inventory has no legitimate
   * need to open a client's passport scan — a bytes-returning version of
   * this method is not a narrower case of this one, it is a different,
   * rejected capability.
   */
  async listMetadataForTenant(tenantId: string): Promise<DocumentMetadata[]> {
    const tenant = await this.tenants.findOne({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException({
        code: MeruErrorCode.TENANT_NOT_FOUND,
        message: 'Tenant not found',
      });
    }

    return this.documents.find({
      where: { tenantId },
      select: [
        'id',
        'name',
        'fileType',
        'originalFileName',
        'fileSize',
        'mimeType',
        'status',
        'linkedEntityType',
        'linkedEntityId',
        'versionNumber',
        'uploadedById',
        'createdAt',
      ],
      order: { createdAt: 'DESC' },
    });
  }
}
