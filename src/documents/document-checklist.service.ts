import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigPack } from '../tenant/entities/config-pack.entity';
import { Document } from './entities/document.entity';

/**
 * One entry in the checklist: what the regulator wants, and whether it is in.
 */
export interface ChecklistItem {
  key: string;
  label: string;
  required: boolean;
  acceptedFormats: string[];
  maxSizeMb: number | null;
  /** Whether AI extraction is configured for this type, and what it pulls. */
  extraction: { enabled: boolean; fields: string[] } | null;
  /** Null when the request did not name an entity — "not asked", not "missing". */
  uploaded: boolean | null;
  documents: Array<{ id: string; name: string; status: string; uploadedAt: Date }>;
}

/**
 * "Which documents does this case still need?" — answered from the tenant's
 * config pack rather than from code.
 *
 * The requirement list is regulatory data: it changes when a regulator changes
 * its mind, and CLAUDE.md §11.3 puts that in a JSON pack, not in `src/`.
 * Hardcoding a visa checklist here would mean a pack update silently stops
 * reaching users — the failure mode the whole four-layer model exists to
 * prevent. This service therefore knows nothing about visas; it reads
 * `schema.documentTypes` from whichever pack serves the caller's vertical.
 */
@Injectable()
export class DocumentChecklistService {
  constructor(
    @InjectRepository(ConfigPack)
    private readonly configPackRepo: Repository<ConfigPack>,
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
  ) {}

  async forEntity(
    tenantId: string,
    vertical: string | null,
    entityId?: string,
  ): Promise<{
    vertical: string | null;
    packCode: string;
    packVersion: string;
    items: ChecklistItem[];
    /** Convenience for the "you still need N documents" line. */
    outstandingRequired: number;
  }> {
    if (!vertical) {
      throw new NotFoundException(
        'No vertical resolved for this tenant, so no document pack applies',
      );
    }

    // Highest active version for the vertical. Sorted in SQL rather than by
    // picking the first row: `findAll` order is not guaranteed, and quietly
    // serving an older pack's checklist is indistinguishable from serving the
    // right one until a regulator's new requirement never appears.
    const pack = await this.configPackRepo.findOne({
      where: { vertical, isActive: true },
      order: { version: 'DESC' },
    });

    if (!pack) {
      throw new NotFoundException(
        `No active config pack for vertical '${vertical}'`,
      );
    }

    const schema = (pack.schema ?? {}) as {
      documentTypes?: Array<{
        key: string;
        label: string;
        required?: boolean;
        acceptedFormats?: string[];
        maxSizeMb?: number;
        aiExtraction?: { enabled?: boolean; fields?: string[] };
      }>;
    };

    const types = schema.documentTypes ?? [];

    // No entity named → report the requirements without pretending to know
    // what has been supplied. `uploaded: null` is deliberately not `false`:
    // "we did not look" and "it is missing" must not render the same, or a
    // checklist with no entityId shows every item as outstanding.
    let byType = new Map<string, Document[]>();
    if (entityId) {
      const docs = await this.documentRepo.find({
        where: { tenantId, linkedEntityId: entityId },
        order: { createdAt: 'DESC' },
      });
      // Matching is on the pack's own vocabulary (`passport`,
      // `skills_assessment`), which core has no column for: `fileType` is the
      // file format (pdf/jpg), not what the document *is*. So an upload
      // declares its type in `metadata.documentTypeKey`, or failing that in
      // `tags`.
      //
      // Consequence worth knowing before wiring an upload UI: a document
      // stored with neither will not match any checklist row, and the item
      // renders as still outstanding even though the file is there. That is
      // the safe direction to fail — telling someone a required document is
      // missing costs them an upload, telling them it is present when the
      // matching failed costs them a refused application — but the uploader
      // must set one of the two.
      byType = docs.reduce((acc, d) => {
        const meta = (d.metadata ?? {}) as { documentTypeKey?: string };
        const keys = meta.documentTypeKey
          ? [meta.documentTypeKey]
          : (d.tags ?? []);
        for (const key of keys) {
          const list = acc.get(key) ?? [];
          list.push(d);
          acc.set(key, list);
        }
        return acc;
      }, new Map<string, Document[]>());
    }

    const items: ChecklistItem[] = types.map((t) => {
      const docs = byType.get(t.key) ?? [];
      return {
        key: t.key,
        label: t.label,
        required: t.required ?? false,
        acceptedFormats: t.acceptedFormats ?? [],
        maxSizeMb: t.maxSizeMb ?? null,
        extraction: t.aiExtraction
          ? {
              enabled: t.aiExtraction.enabled ?? false,
              fields: t.aiExtraction.fields ?? [],
            }
          : null,
        uploaded: entityId ? docs.length > 0 : null,
        documents: docs.map((d) => ({
          id: d.id,
          name: d.name,
          status: String(d.status),
          uploadedAt: d.createdAt,
        })),
      };
    });

    return {
      vertical,
      packCode: pack.code,
      packVersion: pack.version,
      items,
      outstandingRequired: entityId
        ? items.filter((i) => i.required && !i.uploaded).length
        : 0,
    };
  }
}
