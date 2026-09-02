import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  EntityType,
  UniversalEntity,
} from './entities/universal-entity.entity';
import { CrmAccessService } from './crm-access.service';
import { Actor } from '../common/access';

export interface Comment {
  id: string;
  body: string;
  authorId: string;
  parentEntityType: string;
  parentEntityId: string;
  /** Set when a comment is internal-only, i.e. never shown in a client portal. */
  internal: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Comments on any record.
 *
 * Tasks had comments and nothing else did, so three separate requirements —
 * document annotations, case file notes, breach investigation notes — were each
 * scheduled as their own feature. They are one feature: a body of text, an
 * author, and a record it hangs off.
 *
 * Built on the existing polymorphic `note` entity type rather than a new table,
 * because a comment *is* a CRM record: it inherits tenant isolation, the audit
 * trail, soft delete and search indexing for free. A dedicated `comments` table
 * would have had to re-earn all four.
 *
 * `internal` is the field that matters for this product. A migration agent's
 * candid note about a client's chances must never reach the client portal, and
 * a flag on the record is the only place that decision can live where every
 * reader sees it.
 */
@Injectable()
export class CommentService {
  private readonly logger = new Logger(CommentService.name);

  constructor(
    @InjectRepository(UniversalEntity)
    private readonly entities: Repository<UniversalEntity>,
    private readonly access: CrmAccessService,
  ) {}

  /**
   * Add a comment to a record.
   *
   * The parent is verified to exist *in this tenant* before writing. Skipping
   * that check would let a caller attach a comment to an id belonging to
   * another tenant — the comment row itself would be correctly scoped, so
   * nothing would look wrong, and the parent id would silently be a dangling
   * reference.
   *
   * `actor` is required — see `CrmAccessService`. An `own`-scope caller may
   * only comment on a record assigned to them (404 otherwise, matching the
   * rest of this resource), and `internal` is forced to `false` for them
   * server-side: a client-supplied `internal: true`/`false` is not trusted,
   * the same way `includeInternal` on `list()` is not trusted from the query
   * string.
   */
  async add(
    tenantId: string,
    parentType: string,
    parentId: string,
    input: { body: string; authorId: string; internal?: boolean },
    actor: Actor,
  ): Promise<Comment> {
    const body = input.body?.trim();
    if (!body) {
      throw new BadRequestException('A comment needs a body');
    }

    const parent = await this.entities.findOne({
      where: { id: parentId, tenantId },
    });
    if (!parent) {
      throw new BadRequestException(
        `No ${parentType} '${parentId}' in this tenant to comment on`,
      );
    }

    this.access.assert(parent, actor, 'read');

    // An `own`-scope caller cannot mark their own comment internal — internal
    // means "staff-only", and letting a client set it themselves would be
    // meaningless at best and, if the flag is later trusted to mean the note
    // is theirs to hide, an authorisation gap at worst.
    const internal =
      this.access.scopeOf(actor) === 'own' ? false : (input.internal ?? false);

    const saved = await this.entities.save(
      this.entities.create({
        tenantId,
        type: EntityType.NOTE,
        vertical: parent.vertical,
        verticalAttributes: {
          content: body,
          authorId: input.authorId,
          parentEntityType: parent.type,
          parentEntityId: parentId,
          internal,
        },
      }),
    );

    this.logger.log(
      `Comment ${saved.id} added to ${parent.type} ${parentId} by ${input.authorId}`,
    );
    return this.toComment(saved);
  }

  /**
   * Comments on a record, oldest first — the order a thread reads in.
   *
   * `includeInternal` defaults to false so a caller has to *ask* for internal
   * notes. The client portal calls this too, and a default that leaks is a
   * default that will leak.
   *
   * Two checks that used to be missing entirely: `actor` must be able to
   * *read the parent* (an `own`-scope caller only sees comments on records
   * assigned to them), and `includeInternal=true` is honoured only when
   * `CrmAccessService.mayReadInternalNotes` says so — not just whoever asked
   * for it. `GET /crm/entities/:id/comments?includeInternal=true` used to read
   * that flag straight off the query string with no role check at all, so a
   * client could ask for — and receive — the firm's private file notes on any
   * case they could reach. This is deliberately not a default the caller can
   * override: the gate lives here, in the service, not in whether the
   * controller remembers to withhold it.
   */
  async list(
    tenantId: string,
    parentId: string,
    actor: Actor,
    options: { includeInternal?: boolean } = {},
  ): Promise<Comment[]> {
    const parent = await this.entities.findOne({
      where: { id: parentId, tenantId },
    });
    if (!parent) throw new NotFoundException('Entity not found');
    this.access.assert(parent, actor, 'read');

    const includeInternal =
      !!options.includeInternal && this.access.mayReadInternalNotes(actor);

    const rows = await this.entities
      .createQueryBuilder('e')
      .where('e."tenantId" = :tenantId', { tenantId })
      .andWhere('e.type = :type', { type: EntityType.NOTE })
      .andWhere(`e."verticalAttributes"->>'parentEntityId' = :parentId`, {
        parentId,
      })
      .andWhere('e."deletedAt" IS NULL')
      .orderBy('e."createdAt"', 'ASC')
      .getMany();

    return rows
      .map((r) => this.toComment(r))
      .filter((c) => includeInternal || !c.internal);
  }

  /**
   * Remove a comment. Soft delete, because a file note is part of the record.
   *
   * Ownership here is the **comment's author**, not the parent entity's
   * assignee — a client may delete their own message and nothing else.
   * `tenant`/`god` scope keeps today's behaviour exactly: no extra fetch, the
   * same `update()` this always was. The author check only runs for `own`
   * scope, and 404s rather than 403s on someone else's comment, matching the
   * rest of this service's disclosure posture.
   */
  async remove(
    tenantId: string,
    id: string,
    actor: Actor,
  ): Promise<{ deleted: boolean }> {
    if (this.access.scopeOf(actor) === 'own') {
      const comment = await this.entities.findOne({
        where: { id, tenantId, type: EntityType.NOTE },
      });
      if (!comment) throw new NotFoundException('Comment not found');

      const authorId = String(comment.verticalAttributes?.authorId ?? '');
      if (authorId !== actor.id) {
        throw new NotFoundException('Comment not found');
      }
    }

    const result = await this.entities.update(
      { id, tenantId, type: EntityType.NOTE },
      { deletedAt: new Date() },
    );
    return { deleted: (result.affected ?? 0) > 0 };
  }

  private toComment(row: UniversalEntity): Comment {
    const attrs = row.verticalAttributes ?? {};
    return {
      id: row.id,
      body: String(attrs.content ?? ''),
      authorId: String(attrs.authorId ?? ''),
      parentEntityType: String(attrs.parentEntityType ?? ''),
      parentEntityId: String(attrs.parentEntityId ?? ''),
      internal: attrs.internal === true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
