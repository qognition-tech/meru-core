import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { SearchIndex, SearchableType } from './entities/search-index.entity';

// SRCH module facade — currently Postgres ILIKE; planned Phase B work
// is to delegate to ElasticsearchService (./elasticsearch/) for hybrid
// BM25 + pgvector. All 14 modules import SearchService, not the driver.
@Injectable()
export class SearchService {
  constructor(
    @InjectRepository(SearchIndex)
    private searchRepo: Repository<SearchIndex>,
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

    if (existing) {
      return this.searchRepo.save({ ...existing, ...searchData });
    }

    return this.searchRepo.save(searchData);
  }

  async search(tenantId: string, query: string, limit: number = 20) {
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
    await this.searchRepo.delete({
      searchableId,
      searchableType: type,
    });
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
