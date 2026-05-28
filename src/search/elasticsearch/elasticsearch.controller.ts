import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { ElasticsearchService } from './elasticsearch.service';
import { CurrentUser } from '../../iam/decorators/current-user.decorator';
import { TenantId } from '../../tenant/decorators/tenant-id.decorator';
import { JwtAuthGuard } from '../../iam/guards/jwt-auth.guard';
import { UseGuards } from '@nestjs/common';
import {
  SearchDocumentsDto,
  SemanticSearchDto,
  IndexDocumentDto,
  BulkIndexDto,
  CreateIndexDto,
  UpdateMappingDto,
  SuggestQueryDto,
  FacetedSearchDto,
  ReindexDto,
} from './dto/search.dto';
import { ElasticsearchIndex, ElasticsearchDocument, ElasticsearchSearchLog } from './entities/search-index.entity';
import { SearchResult, SearchIndexStats, SearchAnalytics, BulkIndexResult, IndexMapping } from './interfaces/search.interface';

@ApiTags('Elasticsearch')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('elasticsearch')
export class ElasticsearchController {
  constructor(private readonly elasticsearchService: ElasticsearchService) {}

  // ==================== INDEX MANAGEMENT ====================

  @Post('indices')
  @ApiOperation({ summary: 'Create index', description: 'Create a new Elasticsearch index' })
  @ApiResponse({ status: 201, description: 'Index created successfully', type: ElasticsearchIndex })
  async createIndex(
    @Body() dto: CreateIndexDto,
    @TenantId() tenantId: string,
  ): Promise<ElasticsearchIndex> {
    return this.elasticsearchService.createIndex(
      tenantId,
      dto.name,
      dto.entityType,
      dto.mapping as IndexMapping,
      {
        numberOfShards: dto.numberOfShards,
        numberOfReplicas: dto.numberOfReplicas,
      },
    );
  }

  @Get('indices')
  @ApiOperation({ summary: 'List indices', description: 'List all Elasticsearch indices for tenant' })
  @ApiResponse({ status: 200, description: 'Indices retrieved successfully', type: [ElasticsearchIndex] })
  async listIndices(
    @TenantId() tenantId: string,
  ): Promise<ElasticsearchIndex[]> {
    return this.elasticsearchService.getIndices(tenantId);
  }

  @Get('indices/stats')
  @ApiOperation({ summary: 'Get index statistics', description: 'Get statistics for all indices' })
  @ApiResponse({ status: 200, description: 'Statistics retrieved successfully' })
  async getIndexStats(
    @TenantId() tenantId: string,
  ): Promise<SearchIndexStats[]> {
    return this.elasticsearchService.getIndexStats(tenantId);
  }

  @Put('indices/:name/mapping')
  @ApiOperation({ summary: 'Update index mapping', description: 'Update the mapping of an existing index' })
  @ApiResponse({ status: 200, description: 'Mapping updated successfully' })
  async updateMapping(
    @Param('name') indexName: string,
    @Body() dto: UpdateMappingDto,
    @TenantId() tenantId: string,
  ): Promise<void> {
    return this.elasticsearchService.updateMapping(tenantId, indexName, dto.mapping as IndexMapping);
  }

  @Delete('indices/:name')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete index', description: 'Delete an Elasticsearch index' })
  @ApiResponse({ status: 204, description: 'Index deleted successfully' })
  async deleteIndex(
    @Param('name') indexName: string,
    @TenantId() tenantId: string,
  ): Promise<void> {
    return this.elasticsearchService.deleteIndex(tenantId, indexName);
  }

  // ==================== DOCUMENT OPERATIONS ====================

  @Post('indices/:name/documents')
  @ApiOperation({ summary: 'Index document', description: 'Add or update a document in the index' })
  @ApiResponse({ status: 201, description: 'Document indexed successfully' })
  async indexDocument(
    @Param('name') indexName: string,
    @Body() dto: IndexDocumentDto,
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<{ id: string }> {
    const id = await this.elasticsearchService.indexDocument(tenantId, indexName, {
      ...dto,
      type: dto.entityType,
      createdById: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { id };
  }

  @Post('indices/:name/documents/bulk')
  @ApiOperation({ summary: 'Bulk index documents', description: 'Index multiple documents at once' })
  @ApiResponse({ status: 200, description: 'Bulk index completed', type: Object })
  async bulkIndex(
    @Param('name') indexName: string,
    @Body() dto: BulkIndexDto,
    @TenantId() tenantId: string,
  ): Promise<BulkIndexResult> {
    const operations = dto.documents.map(doc => ({
      operation: 'index' as const,
      id: doc.entityId,
      document: {
        ...doc,
        type: doc.entityType,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    }));

    return this.elasticsearchService.bulkIndex(tenantId, indexName, operations);
  }

  @Get('indices/:name/documents/:id')
  @ApiOperation({ summary: 'Get document', description: 'Retrieve a document by ID' })
  @ApiResponse({ status: 200, description: 'Document retrieved successfully' })
  async getDocument(
    @Param('name') indexName: string,
    @Param('id') documentId: string,
    @TenantId() tenantId: string,
  ): Promise<any> {
    return this.elasticsearchService.getDocument(tenantId, indexName, documentId);
  }

  @Delete('indices/:name/documents/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete document', description: 'Remove a document from the index' })
  @ApiResponse({ status: 204, description: 'Document deleted successfully' })
  async deleteDocument(
    @Param('name') indexName: string,
    @Param('id') documentId: string,
    @TenantId() tenantId: string,
  ): Promise<void> {
    return this.elasticsearchService.deleteDocument(tenantId, indexName, documentId);
  }

  // ==================== SEARCH ====================

  @Post('search')
  @ApiOperation({ summary: 'Search documents', description: 'Full-text search across indices' })
  @ApiResponse({ status: 200, description: 'Search completed successfully', type: Object })
  async search(
    @Body() dto: SearchDocumentsDto,
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<SearchResult> {
    return this.elasticsearchService.search(
      tenantId,
      {
        query: dto.query,
        filters: dto.filters ? Object.entries(dto.filters).map(([field, value]) => ({
          field,
          operator: 'eq',
          value,
        })) : undefined,
        sort: [{ field: dto.sortBy || '_score', order: dto.sortOrder || 'desc' }],
        pagination: {
          from: ((dto.page || 1) - 1) * (dto.limit || 20),
          size: dto.limit || 20,
        },
        highlights: dto.highlights,
      },
      userId,
    );
  }

  @Post('search/semantic')
  @ApiOperation({ summary: 'Semantic search', description: 'Vector-based semantic search' })
  @ApiResponse({ status: 200, description: 'Semantic search completed', type: Object })
  async semanticSearch(
    @Body() dto: SemanticSearchDto,
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<SearchResult> {
    // In production, generate embedding from query text using OpenAI
    // For now, return empty embedding - would need AI service integration
    const embedding: number[] = [];
    
    return this.elasticsearchService.semanticSearch(
      tenantId,
      dto.query,
      embedding,
      dto.k,
      dto.threshold,
    );
  }

  @Post('search/faceted')
  @ApiOperation({ summary: 'Faceted search', description: 'Search with faceted aggregations' })
  @ApiResponse({ status: 200, description: 'Faceted search completed', type: Object })
  async facetedSearch(
    @Body() dto: FacetedSearchDto,
    @TenantId() tenantId: string,
  ): Promise<SearchResult> {
    return this.elasticsearchService.facetedSearch(
      tenantId,
      dto.query,
      dto.facets,
    );
  }

  @Post('suggest')
  @ApiOperation({ summary: 'Get suggestions', description: 'Get search query suggestions' })
  @ApiResponse({ status: 200, description: 'Suggestions retrieved', type: [String] })
  async suggest(
    @Body() dto: SuggestQueryDto,
    @TenantId() tenantId: string,
  ): Promise<string[]> {
    return this.elasticsearchService.suggest(tenantId, {
      text: dto.text,
      field: dto.field,
      size: dto.size,
    });
  }

  // ==================== ANALYTICS ====================

  @Get('analytics')
  @ApiOperation({ summary: 'Get search analytics', description: 'Get search usage analytics' })
  @ApiResponse({ status: 200, description: 'Analytics retrieved successfully' })
  @ApiQuery({ name: 'days', required: false, type: Number, description: 'Number of days to analyze' })
  async getAnalytics(
    @TenantId() tenantId: string,
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
  ): Promise<SearchAnalytics> {
    return this.elasticsearchService.getAnalytics(tenantId, days);
  }

  @Get('search-logs')
  @ApiOperation({ summary: 'Get search logs', description: 'Get recent search queries' })
  @ApiResponse({ status: 200, description: 'Search logs retrieved', type: [ElasticsearchSearchLog] })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Number of logs to return' })
  async getSearchLogs(
    @TenantId() tenantId: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ): Promise<ElasticsearchSearchLog[]> {
    return this.elasticsearchService.searchLogRepo.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
