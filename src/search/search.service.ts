import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { SearchIndex, SearchableType } from './entities/search-index.entity';
import { ElasticsearchService } from './elasticsearch/elasticsearch.service';
import type { SearchDocument } from './elasticsearch/interfaces/search.interface';

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

  async indexEntityData(entity: any) {
    const existing = await this.searchRepo.findOne({
      where: {
        searchableId: entity.id,
        searchableType: SearchableType.ENTITY,
      },
    });

    const searchData = {
      tenantId: entity.tenantId,
      searchableType: SearchableType.ENTITY,
      searchableId: entity.id,
      title:
        `${entity.firstName || ''} ${entity.lastName || ''}`.trim() ||
        entity.email ||
        'Unknown',
      content: this.generateContent(entity),
      metadata: {
        entityType: entity.type,
        email: entity.email,
        phoneNumber: entity.phoneNumber,
        verticalAttributes: entity.verticalAttributes,
      },
    };

    const row = existing
      ? await this.searchRepo.save({ ...existing, ...searchData })
      : await this.searchRepo.save(searchData);

    await this.mirrorToElasticsearch(row);
    return row;
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

  async search(tenantId: string, query: string, limit: number = 20) {
    if (this.es.available) {
      try {
        return await this.searchElasticsearch(tenantId, query, limit);
      } catch (err) {
        this.logger.warn(
          `Elasticsearch query failed, answering from Postgres: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return this.searchPostgres(tenantId, query, limit);
  }

  private async searchElasticsearch(
    tenantId: string,
    query: string,
    limit: number,
  ) {
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
  ) {
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

  async indexBulk(entities: any[]) {
    for (const entity of entities) {
      await this.indexEntityData(entity);
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
