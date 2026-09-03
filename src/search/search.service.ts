import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { SearchIndex, SearchableType } from './entities/search-index.entity';
import { ElasticsearchService } from './elasticsearch/elasticsearch.service';
import type { SearchDocument } from './elasticsearch/interfaces/search.interface';
import type { SearchResultDto } from './dto/search-result.dto';
import { Actor, scopeOf } from '../common/access';

/** The ES index every CRM entity lands in, per tenant. */
const ENTITY_INDEX = 'entities';

/**
 * SRCH module facade. All 14 modules import SearchService, not the driver.
 *
 * Postgres `search_index` is the source of truth and is always written.
 * When Elasticsearch answered its boot-time ping, every write is mirrored
 * there and `search()` queries it first — BM25 with fuzziness, instead of a
 * substring match. When the cluster is down, or a query fails, the Postgres
 * ILIKE path answers instead and the fallback is logged. Callers never see
 * which engine answered, and the result shape is identical, so nothing in
 * the three portals changes.
 *
 * For months this class was an ILIKE facade with a comment promising to
 * delegate "in Phase B", while `ElasticsearchService` sat beside it as a
 * route-only silo that nothing indexed into. Both halves existed; neither
 * called the other.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    @InjectRepository(SearchIndex)
    private searchRepo: Repository<SearchIndex>,
    private readonly es: ElasticsearchService,
  ) {}

  /**
   * `overrideTenantId`, when passed, wins over whatever `entity.tenantId`
   * says.
   *
   * `POST /search/index/entity` and `POST /search/index/bulk` used to trust
   * the request body's `entity.tenantId` outright — a `client` token (once
   * the routes are also role-gated: see the controller) could index, or
   * overwrite, a row under any tenant id it named, because the dedup lookup
   * below matched on `searchableId` alone with no `tenantId` in the `WHERE` —
   * a cross-tenant overwrite primitive. The controller now passes
   * `req.user.tenantId` here; every internal caller (CRM, tasks, workflow,
   * documents, forms) keeps working unchanged because it never passes this
   * second argument and `entity.tenantId` — already the caller's own,
   * server-derived value — is used exactly as before.
   *
   * Two payload shapes reach this method. `crm.service.ts` and
   * `orchestration.service.ts` pass a real `UniversalEntity` row, keyed on
   * `.id`, with no `searchableType` of its own — those always mean
   * `SearchableType.ENTITY`. `task.service.ts`, `form-builder.service.ts`,
   * `workflow.service.ts` and `document-hub.service.ts` pass a wrapper object
   * that already carries its own `searchableId`/`searchableType` fields. This
   * method used to read `entity.id` unconditionally and hardcode
   * `SearchableType.ENTITY`, so every wrapped caller wrote `searchableId:
   * undefined` against a NOT NULL column — an insert that always threw, into
   * a try/catch that only logged. Tasks, form submissions, workflow instances
   * and documents had never once landed in the index.
   */
  async indexEntityData(entity: any, overrideTenantId?: string) {
    const tenantId = overrideTenantId ?? entity.tenantId;
    const searchableId: unknown = entity.searchableId ?? entity.id;
    const searchableType: SearchableType = this.resolveSearchableType(
      entity.searchableType,
    );

    // Loud, not swallowed: the class of failure this whole method exists to
    // close was an undefined id reaching the database and throwing a bare
    // Postgres NOT NULL violation that every caller's try/catch logged and
    // moved on from. A named, specific error here is at least diagnosable
    // from that same log line; the caller's catch-and-continue is correct
    // (search indexing must never fail the write it is indexing) but the
    // message it logs should say exactly what was missing.
    if (typeof searchableId !== 'string' || searchableId.length === 0) {
      throw new Error(
        `SearchService.indexEntityData: no searchableId/id on a ` +
          `"${searchableType}" payload for tenant ${tenantId ?? 'unknown'} — ` +
          `refusing to index`,
      );
    }

    const existing = await this.searchRepo.findOne({
      where: {
        tenantId,
        searchableId,
        searchableType,
      },
    });

    const searchData = {
      tenantId,
      searchableType,
      searchableId,
      // Wrapper callers (tasks, forms, workflow instances, documents) already
      // computed their own `title`/`content` — a task's title is its title,
      // not a person's name. Only a bare CRM entity (no `title` field on
      // `UniversalEntity`) falls through to the name/email derivation below.
      // Fixing the id/type above and leaving this branch untouched would have
      // indexed every task, form submission and workflow instance under the
      // title "Unknown" with an empty snippet — indexed, but unfindable by
      // anything a person would actually type.
      title:
        entity.title ??
        (`${entity.firstName || ''} ${entity.lastName || ''}`.trim() ||
          entity.email ||
          'Unknown'),
      content:
        typeof entity.content === 'string'
          ? entity.content
          : this.generateContent(entity),
      metadata: {
        entityType: entity.type,
        email: entity.email,
        phoneNumber: entity.phoneNumber,
        verticalAttributes: entity.verticalAttributes,
        // Present only when the caller is a CRM entity row itself
        // (`crm.service.ts` passes the real entity) — used to scope
        // `GET /search` to a client's own records in `scopeResults` below.
        // Callers that wrap their payload (tasks, workflow, documents, forms)
        // do not carry this field on the outer object, so their rows are
        // simply excluded from a client's results rather than mis-scoped.
        assignedTo: entity.assignedTo ?? null,
      },
    };

    const row = existing
      ? await this.searchRepo.save({ ...existing, ...searchData })
      : await this.searchRepo.save(searchData);

    await this.mirrorToElasticsearch(row);
    return row;
  }

  /**
   * A caller's `searchableType` string, validated against the real enum
   * rather than cast straight through. `entity.searchableType` is a plain
   * string on every wrapper payload (it crosses a module boundary as a
   * literal, not the enum type), so a typo or a future caller inventing its
   * own label would otherwise reach Postgres as a value the column's own enum
   * type rejects — a worse failure than falling back to `ENTITY`, which is
   * at least indexed and findable. A bare CRM entity (no `searchableType`
   * field at all) always resolves to `ENTITY`, exactly as before this method
   * read the wrapper shape at all.
   */
  private resolveSearchableType(candidate: unknown): SearchableType {
    if (
      typeof candidate === 'string' &&
      (Object.values(SearchableType) as string[]).includes(candidate)
    ) {
      return candidate as SearchableType;
    }
    return SearchableType.ENTITY;
  }

  /**
   * Best effort, never blocking: Postgres already holds the row, so a failed
   * mirror costs ranking quality, not data.
   */
  private async mirrorToElasticsearch(row: SearchIndex): Promise<void> {
    if (!this.es.available) return;
    try {
      await this.es.indexDocument(row.tenantId, ENTITY_INDEX, {
        id: row.searchableId,
        type: row.searchableType,
        title: row.title,
        content: row.content,
        metadata: row.metadata ?? {},
        tags: [],
      });
    } catch (err) {
      this.logger.warn(
        `Elasticsearch mirror failed for ${row.searchableId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Liveness probe for `GET /orchestration/health`; see CrmService.probe. */
  async probe(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.searchRepo.manager.query('SELECT 1 FROM "search_index" LIMIT 1');
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * `actor`, when passed, narrows results for a non-staff caller.
   *
   * `GET /search` used to hand a `client` token titles and snippets of every
   * record in the tenant — full-text search has no natural query-level
   * tenant-user scope the way `/crm/entities?assignedTo=` does, so this
   * filters the answer down to what `indexEntityData` tagged as the caller's
   * own (`metadata.assignedTo`, present on CRM-entity rows). Internal callers
   * (tasks, workflow, documents, forms, orchestration) do not pass `actor`
   * and keep the unrestricted tenant-wide answer they always got — this is
   * the *client route's* scoping, not a change to what indexing means.
   *
   * Narrowing happens after the page is fetched, so a scoped caller can see
   * fewer than `limit` hits even when more of their own records exist further
   * down the ranking. Acceptable for a safety filter — it can only under- not
   * over-return — but a caller wanting exhaustive results should page.
   */
  async search(
    tenantId: string,
    query: string,
    limit: number = 20,
    actor?: Actor,
  ): Promise<SearchResultDto[]> {
    let results: SearchResultDto[];
    if (this.es.available) {
      try {
        results = await this.searchElasticsearch(tenantId, query, limit);
      } catch (err) {
        this.logger.warn(
          `Elasticsearch query failed, answering from Postgres: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        results = await this.searchPostgres(tenantId, query, limit);
      }
    } else {
      results = await this.searchPostgres(tenantId, query, limit);
    }
    return this.scopeResults(results, actor);
  }

  private scopeResults(
    results: SearchResultDto[],
    actor?: Actor,
  ): SearchResultDto[] {
    if (!actor || scopeOf(actor) !== 'own') return results;
    return results.filter((r) => r.metadata?.assignedTo === actor.id);
  }

  private async searchElasticsearch(
    tenantId: string,
    query: string,
    limit: number,
  ): Promise<SearchResultDto[]> {
    const result = await this.es.search(tenantId, {
      query,
      filters: [
        { field: 'index', operator: 'eq', value: [ENTITY_INDEX] },
        { field: 'tenantId', operator: 'eq', value: tenantId },
      ],
      pagination: { size: limit },
      highlights: true,
    });

    return result.documents.map((doc, i) => {
      const highlight = result.highlights?.[i]?.content?.[0];
      return {
        id: doc.id,
        type: doc.type as SearchableType,
        searchableId: doc.id,
        title: doc.title,
        snippet: highlight ?? this.getSnippet(doc.content ?? '', query),
        metadata: doc.metadata,
        score: (doc as SearchDocument & { score?: number }).score ?? 0,
      };
    });
  }

  private async searchPostgres(
    tenantId: string,
    query: string,
    limit: number,
  ): Promise<SearchResultDto[]> {
    const results = await this.searchRepo.find({
      where: [
        // ILike, not Like. TypeORM's Like maps to SQL LIKE, which is
        // case-SENSITIVE in Postgres — so searching "john" never matched a
        // record titled "John", and every search in every portal silently
        // under-returned. The comment above always claimed ILIKE; the code
        // did not.
        { tenantId, title: ILike(`%${query}%`) },
        { tenantId, content: ILike(`%${query}%`) },
      ],
      take: limit,
      order: { updatedAt: 'DESC' },
    });

    return results
      .map((r) => ({
        id: r.id,
        type: r.searchableType,
        searchableId: r.searchableId,
        title: r.title,
        snippet: this.getSnippet(r.content, query),
        metadata: r.metadata,
        score: this.calculateScore(r.title, r.content, query),
      }))
      .sort((a, b) => b.score - a.score);
  }

  async indexBulk(entities: any[], overrideTenantId?: string) {
    for (const entity of entities) {
      await this.indexEntityData(entity, overrideTenantId);
    }

    return { indexed: entities.length };
  }

  async deleteFromIndex(searchableId: string, type: SearchableType) {
    const row = await this.searchRepo.findOne({
      where: { searchableId, searchableType: type },
    });
    await this.searchRepo.delete({
      searchableId,
      searchableType: type,
    });
    if (row && this.es.available) {
      try {
        await this.es.deleteDocument(row.tenantId, ENTITY_INDEX, searchableId);
      } catch (err) {
        this.logger.warn(
          `Elasticsearch delete failed for ${searchableId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private generateContent(entity: any): string {
    const parts: string[] = [];

    if (entity.firstName) parts.push(entity.firstName);
    if (entity.lastName) parts.push(entity.lastName);
    if (entity.email) parts.push(entity.email);
    if (entity.phoneNumber) parts.push(entity.phoneNumber);

    const attr = entity.verticalAttributes || {};
    Object.values(attr).forEach((val: any) => {
      if (typeof val === 'string' && val.trim()) {
        parts.push(val);
      }
    });

    return parts.join(' ').toLowerCase();
  }

  private getSnippet(
    content: string,
    query: string,
    maxLength: number = 150,
  ): string {
    const lowerContent = content.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const index = lowerContent.indexOf(lowerQuery);

    if (index === -1) return content.substring(0, maxLength) + '...';

    const start = Math.max(0, index - 50);
    const end = Math.min(content.length, index + query.length + 50);

    let snippet = content.substring(start, end);
    if (start > 0) snippet = '...' + snippet;
    if (end < content.length) snippet = snippet + '...';

    return snippet;
  }

  private calculateScore(
    title: string,
    content: string,
    query: string,
  ): number {
    const lowerTitle = title.toLowerCase();
    const lowerContent = content.toLowerCase();
    const lowerQuery = query.toLowerCase();

    let score = 0;

    if (lowerTitle.includes(lowerQuery)) score += 10;
    if (lowerTitle.startsWith(lowerQuery)) score += 5;

    const queryWords = lowerQuery.split(' ');
    queryWords.forEach((word) => {
      const titleMatches = (lowerTitle.match(new RegExp(word, 'g')) || [])
        .length;
      const contentMatches = (lowerContent.match(new RegExp(word, 'g')) || [])
        .length;
      score += titleMatches * 3;
      score += contentMatches;
    });

    return score;
  }
}
