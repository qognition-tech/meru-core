import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@elastic/elasticsearch';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ElasticsearchIndex, ElasticsearchDocument, ElasticsearchSearchLog } from './entities/search-index.entity';
import {
  SearchQuery,
  SearchResult,
  SearchDocument,
  IndexMapping,
  BulkIndexOperation,
  BulkIndexResult,
  SearchIndexStats,
  SearchAnalytics,
  SuggestOptions,
  SearchAggregation,
  AggregationResult,
} from './interfaces/search.interface';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class ElasticsearchService implements OnModuleInit {
  private readonly logger = new Logger(ElasticsearchService.name);
  private client: Client;
  private readonly indexPrefix: string;

  constructor(
    private configService: ConfigService,
    @InjectRepository(ElasticsearchIndex)
    private indexRepo: Repository<ElasticsearchIndex>,
    @InjectRepository(ElasticsearchDocument)
    private documentRepo: Repository<ElasticsearchDocument>,
    @InjectRepository(ElasticsearchSearchLog)
    public searchLogRepo: Repository<ElasticsearchSearchLog>,
  ) {
    this.indexPrefix = this.configService.get('ELASTICSEARCH_INDEX_PREFIX', 'meru');
  }

  async onModuleInit() {
    const host = this.configService.get('ELASTICSEARCH_HOST', 'localhost:9200');
    const username = this.configService.get('ELASTICSEARCH_USERNAME');
    const password = this.configService.get('ELASTICSEARCH_PASSWORD');

    this.client = new Client({
      node: `http://${host}`,
      auth: username && password ? { username, password } : undefined,
    });

    try {
      await this.client.ping();
      this.logger.log('Elasticsearch connected successfully');
    } catch (error) {
      this.logger.error('Elasticsearch connection failed:', error.message);
    }
  }

  // ==================== INDEX MANAGEMENT ====================

  async createIndex(
    tenantId: string,
    name: string,
    entityType: string,
    mapping?: IndexMapping,
    settings?: { numberOfShards?: number; numberOfReplicas?: number },
  ): Promise<ElasticsearchIndex> {
    const indexName = this.getIndexName(tenantId, name);

    const defaultMapping: IndexMapping = mapping || {
      properties: {
        id: { type: 'keyword' },
        tenantId: { type: 'keyword' },
        title: { 
          type: 'text',
          analyzer: 'standard',
          fields: {
            keyword: { type: 'keyword' },
          },
        },
        content: { 
          type: 'text',
          analyzer: 'standard',
        },
        tags: { type: 'keyword' },
        metadata: { type: 'object' },
        createdAt: { type: 'date' },
        updatedAt: { type: 'date' },
        createdById: { type: 'keyword' },
      },
    };

    try {
      const exists = await this.client.indices.exists({ index: indexName });
      
      if (!exists) {
        await this.client.indices.create({
          index: indexName,
          settings: {
            number_of_shards: settings?.numberOfShards || 1,
            number_of_replicas: settings?.numberOfReplicas || 0,
            analysis: {
              analyzer: {
                custom_analyzer: {
                  type: 'custom',
                  tokenizer: 'standard',
                  filter: ['lowercase', 'asciifolding'],
                },
              },
            },
          },
          mappings: defaultMapping as any,
        });
      }

      const index = this.indexRepo.create({
        id: uuidv4(),
        tenantId,
        name,
        entityType,
        mapping: JSON.stringify(defaultMapping),
        settings: {
          numberOfShards: settings?.numberOfShards || 1,
          numberOfReplicas: settings?.numberOfReplicas || 0,
          refreshInterval: '1s',
        },
      });

      return this.indexRepo.save(index);
    } catch (error) {
      this.logger.error(`Failed to create index: ${error.message}`);
      throw error;
    }
  }

  async updateMapping(tenantId: string, indexName: string, mapping: IndexMapping): Promise<void> {
    const fullIndexName = this.getIndexName(tenantId, indexName);

    await this.client.indices.putMapping({
      index: fullIndexName,
      properties: mapping.properties as any,
    });

    // Update in database
    const index = await this.indexRepo.findOne({ where: { tenantId, name: indexName } });
    if (index) {
      index.mapping = JSON.stringify(mapping);
      await this.indexRepo.save(index);
    }
  }

  async deleteIndex(tenantId: string, indexName: string): Promise<void> {
    const fullIndexName = this.getIndexName(tenantId, indexName);

    await this.client.indices.delete({ index: fullIndexName });
    await this.indexRepo.delete({ tenantId, name: indexName });
  }

  async getIndices(tenantId: string): Promise<ElasticsearchIndex[]> {
    return this.indexRepo.find({ where: { tenantId } });
  }

  async getIndexStats(tenantId: string): Promise<SearchIndexStats[]> {
    const indices = await this.getIndices(tenantId);
    const stats: SearchIndexStats[] = [];

    for (const index of indices) {
      try {
        const indexStats = await this.client.indices.stats({
          index: this.getIndexName(tenantId, index.name),
        });

        const health = await this.client.cluster.health({
          index: this.getIndexName(tenantId, index.name),
        });

        stats.push({
          index: index.name,
          docCount: indexStats.indices?.[this.getIndexName(tenantId, index.name)]?.total?.docs?.count || 0,
          sizeInBytes: indexStats.indices?.[this.getIndexName(tenantId, index.name)]?.total?.store?.size_in_bytes || 0,
          health: health.status as 'green' | 'yellow' | 'red',
          status: 'open',
          shards: {
            total: health.active_shards || 0,
            successful: health.active_shards || 0,
            failed: health.unassigned_shards || 0,
          },
        });
      } catch (error) {
        this.logger.error(`Failed to get stats for index ${index.name}: ${error.message}`);
      }
    }

    return stats;
  }

  // ==================== DOCUMENT OPERATIONS ====================

  async indexDocument(
    tenantId: string,
    indexName: string,
    document: Partial<SearchDocument>,
    generateEmbedding: boolean = false,
  ): Promise<string> {
    const fullIndexName = this.getIndexName(tenantId, indexName);
    const docId = document.id || uuidv4();

    const docToIndex = {
      ...document,
      id: docId,
      tenantId,
      indexedAt: new Date().toISOString(),
    };

    // Generate embedding if requested (would need OpenAI service)
    if (generateEmbedding && document.content) {
      // docToIndex.embedding = await this.generateEmbedding(document.content);
    }

    await this.client.index({
      index: fullIndexName,
      id: docId,
      document: docToIndex,
      refresh: true,
    });

    // Track in database
    const index = await this.indexRepo.findOne({ where: { tenantId, name: indexName } });
    if (index) {
      index.documentCount += 1;
      index.lastIndexedAt = new Date();
      await this.indexRepo.save(index);

      const doc = this.documentRepo.create({
        id: uuidv4(),
        tenantId,
        indexId: index.id,
        entityType: document.type || 'unknown',
        entityId: docId,
        documentId: docId,
        content: document.content || '',
        tags: document.tags || [],
        metadata: document.metadata || {},
        embedding: (docToIndex as any).embedding || null,
        isIndexed: true,
      });
      await this.documentRepo.save(doc);
    }

    return docId;
  }

  async bulkIndex(
    tenantId: string,
    indexName: string,
    operations: BulkIndexOperation[],
  ): Promise<BulkIndexResult> {
    const fullIndexName = this.getIndexName(tenantId, indexName);

    const body = operations.flatMap(op => [
      { [op.operation]: { _index: fullIndexName, _id: op.id } },
      op.operation === 'delete' ? undefined : op.document,
    ]).filter(Boolean);

    const result = await this.client.bulk({ refresh: true, body });

    const items = result.items?.map((item: any) => ({
      operation: Object.keys(item)[0],
      index: fullIndexName,
      id: item.index?._id || item.create?._id || item.update?._id || item.delete?._id,
      result: item.index?.result || item.create?.result || item.update?.result || item.delete?.result,
      status: item.index?.status || item.create?.status || item.update?.status || item.delete?.status,
      error: item.index?.error || item.create?.error || item.update?.error || item.delete?.error,
    })) || [];

    const successful = items.filter((i: any) => i.status >= 200 && i.status < 300).length;
    const failed = items.filter((i: any) => i.status >= 400).length;

    return {
      took: result.took || 0,
      errors: result.errors || false,
      items,
      total: items.length,
      successful,
      failed,
    };
  }

  async deleteDocument(tenantId: string, indexName: string, documentId: string): Promise<void> {
    const fullIndexName = this.getIndexName(tenantId, indexName);

    await this.client.delete({
      index: fullIndexName,
      id: documentId,
      refresh: true,
    });

    await this.documentRepo.delete({ tenantId, documentId });
  }

  async getDocument(tenantId: string, indexName: string, documentId: string): Promise<SearchDocument> {
    const fullIndexName = this.getIndexName(tenantId, indexName);

    const result = await this.client.get<SearchDocument>({
      index: fullIndexName,
      id: documentId,
    });

    return result._source!;
  }

  // ==================== SEARCH ====================

  async search(
    tenantId: string,
    query: SearchQuery,
    userId?: string,
  ): Promise<SearchResult> {
    const startTime = Date.now();
    const indices = query.filters?.find(f => f.field === 'index')?.value || ['*'];
    const indexNames = indices.map((i: string) => this.getIndexName(tenantId, i));

    const searchBody: any = {
      query: this.buildQuery(query),
      from: query.pagination?.from || 0,
      size: query.pagination?.size || 20,
    };

    if (query.sort) {
      searchBody.sort = query.sort.map(s => ({ [s.field]: { order: s.order, mode: s.mode } }));
    }

    if (query.highlights) {
      searchBody.highlight = {
        fields: {
          title: {},
          content: { fragment_size: 150, number_of_fragments: 3 },
        },
        pre_tags: ['<mark>'],
        post_tags: ['</mark>'],
      };
    }

    if (query.aggregations) {
      searchBody.aggs = this.buildAggregations(query.aggregations);
    }

    // Vector search
    if (query.vectorSearch) {
      searchBody.query = {
        script_score: {
          query: searchBody.query,
          script: {
            source: "cosineSimilarity(params.query_vector, 'embedding') + 1.0",
            params: { query_vector: query.vectorSearch.embedding },
          },
        },
      };
      searchBody.size = query.vectorSearch.k || 10;
    }

    const result = await this.client.search<SearchDocument>({
      index: indexNames,
      body: searchBody,
    });

    const took = Date.now() - startTime;

    // Log search
    await this.logSearch(tenantId, query.query, indices, (result.hits.total as any)?.value || 0, took, userId);

    const documents = result.hits.hits.map(hit => ({
      ...hit._source!,
      id: hit._id || '',
      score: hit._score,
    })) as SearchDocument[];

    return {
      total: (result.hits.total as any)?.value || 0,
      took,
      documents,
      highlights: result.hits.hits.map(h => h.highlight as Record<string, string[]>),
      aggregations: result.aggregations as Record<string, AggregationResult>,
    };
  }

  async semanticSearch(
    tenantId: string,
    query: string,
    embedding: number[],
    k: number = 10,
    threshold: number = 0.7,
  ): Promise<SearchResult> {
    return this.search(tenantId, {
      query,
      vectorSearch: {
        embedding,
        similarity: 'cosine',
        k,
      },
    });
  }

  async suggest(
    tenantId: string,
    options: SuggestOptions,
  ): Promise<string[]> {
    const result = await this.client.search({
      index: `${this.indexPrefix}-${tenantId}-*`,
      suggest: {
        completion: {
          text: options.text,
          completion: {
            field: options.field || 'title.suggest',
            size: options.size || 5,
            fuzzy: options.fuzzy ? { fuzziness: 'AUTO' } : undefined,
          },
        },
      },
    });

    const suggestions = (result.suggest?.completion || []) as any[];
    return suggestions.flatMap(s => s.options.map((o: any) => o.text));
  }

  async facetedSearch(
    tenantId: string,
    query: string,
    facetFields: string[],
  ): Promise<SearchResult> {
    const aggregations: SearchAggregation[] = facetFields.map(field => ({
      name: `${field}_facets`,
      type: 'terms',
      field,
      options: { size: 10 },
    }));

    return this.search(tenantId, {
      query,
      aggregations,
    });
  }

  // ==================== ANALYTICS ====================

  async getAnalytics(tenantId: string, days: number = 30): Promise<SearchAnalytics> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [totalQueries, avgResponseTime, popularQueries, zeroResults] = await Promise.all([
      this.searchLogRepo.count({ where: { tenantId, createdAt: since } }),
      this.searchLogRepo
        .createQueryBuilder('log')
        .where('log.tenantId = :tenantId', { tenantId })
        .andWhere('log.createdAt >= :since', { since })
        .select('AVG(log.responseTimeMs)', 'avg')
        .getRawOne(),
      this.searchLogRepo
        .createQueryBuilder('log')
        .where('log.tenantId = :tenantId', { tenantId })
        .andWhere('log.createdAt >= :since', { since })
        .select('log.query', 'query')
        .addSelect('COUNT(*)', 'count')
        .groupBy('log.query')
        .orderBy('count', 'DESC')
        .limit(10)
        .getRawMany(),
      this.searchLogRepo
        .createQueryBuilder('log')
        .where('log.tenantId = :tenantId', { tenantId })
        .andWhere('log.createdAt >= :since', { since })
        .andWhere('log.hasResults = false')
        .select('log.query', 'query')
        .addSelect('COUNT(*)', 'count')
        .groupBy('log.query')
        .orderBy('count', 'DESC')
        .limit(10)
        .getRawMany(),
    ]);

    return {
      totalQueries,
      avgResponseTime: parseFloat(avgResponseTime?.avg) || 0,
      popularQueries: popularQueries.map(q => ({ query: q.query, count: parseInt(q.count) })),
      zeroResultsQueries: zeroResults.map(q => ({ query: q.query, count: parseInt(q.count) })),
      queryLatencyDistribution: {}, // Could be implemented with histogram aggregation
    };
  }

  // ==================== PRIVATE HELPERS ====================

  private getIndexName(tenantId: string, indexName: string): string {
    return `${this.indexPrefix}-${tenantId}-${indexName}`.toLowerCase();
  }

  private buildQuery(query: SearchQuery): any {
    const must: any[] = [
      {
        multi_match: {
          query: query.query,
          fields: ['title^3', 'content', 'tags^2', 'metadata.*'],
          type: 'best_fields',
          fuzziness: 'AUTO',
        },
      },
    ];

    if (query.filters) {
      for (const filter of query.filters) {
        if (filter.field === 'index') continue; // Skip index filter

        const filterClause = this.buildFilter(filter);
        if (filterClause) {
          must.push(filterClause);
        }
      }
    }

    return {
      bool: {
        must,
        filter: [
          { term: { tenantId: query.filters?.find(f => f.field === 'tenantId')?.value } },
        ],
      },
    };
  }

  private buildFilter(filter: any): any {
    switch (filter.operator) {
      case 'eq':
        return { term: { [filter.field]: filter.value } };
      case 'match':
        return { match: { [filter.field]: filter.value } };
      case 'match_phrase':
        return { match_phrase: { [filter.field]: filter.value } };
      case 'range':
        return { range: { [filter.field]: filter.value } };
      case 'exists':
        return { exists: { field: filter.field } };
      case 'in':
        return { terms: { [filter.field]: filter.value } };
      default:
        return null;
    }
  }

  private buildAggregations(aggregations: SearchAggregation[]): Record<string, any> {
    const result: Record<string, any> = {};

    for (const agg of aggregations) {
      switch (agg.type) {
        case 'terms':
          result[agg.name] = {
            terms: {
              field: agg.field,
              size: agg.options?.size || 10,
            },
          };
          break;
        case 'date_histogram':
          result[agg.name] = {
            date_histogram: {
              field: agg.field,
              calendar_interval: agg.options?.interval || 'month',
            },
          };
          break;
        case 'stats':
          result[agg.name] = {
            stats: { field: agg.field },
          };
          break;
        case 'cardinality':
          result[agg.name] = {
            cardinality: { field: agg.field },
          };
          break;
      }

      if (agg.subAggregations) {
        result[agg.name].aggs = this.buildAggregations(agg.subAggregations);
      }
    }

    return result;
  }

  private async logSearch(
    tenantId: string,
    query: string,
    indices: string[],
    resultsCount: number,
    responseTimeMs: number,
    userId?: string,
  ): Promise<void> {
    const log = this.searchLogRepo.create({
      tenantId,
      userId: userId || null,
      query,
      indices,
      resultsCount,
      responseTimeMs,
      hasResults: resultsCount > 0,
    });

    await this.searchLogRepo.save(log);
  }
}
