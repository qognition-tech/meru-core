import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  EntityType,
  UniversalEntity,
} from './entities/universal-entity.entity';

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
  ) {}

  /**
   * Add a comment to a record.
   *
   * The parent is verified to exist *in this tenant* before writing. Skipping
   * that check would let a caller attach a comment to an id belonging to
   * another tenant — the comment row itself would be correctly scoped, so
   * nothing would look wrong, and the parent id would silently be a dangling
   * reference.
   */
  async add(
    tenantId: string,
    parentType: string,
    parentId: string,
    input: { body: string; authorId: string; internal?: boolean },
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
          internal: input.internal ?? false,
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
   */
  async list(
    tenantId: string,
    parentId: string,
    options: { includeInternal?: boolean } = {},
  ): Promise<Comment[]> {
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
      .filter((c) => options.includeInternal || !c.internal);
  }

  /** Remove a comment. Soft delete, because a file note is part of the record. */
  async remove(tenantId: string, id: string): Promise<{ deleted: boolean }> {
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
