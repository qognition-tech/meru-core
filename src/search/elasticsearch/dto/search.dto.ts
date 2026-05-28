import {
  IsString,
  IsOptional,
  IsEnum,
  IsObject,
  IsArray,
  IsNumber,
  Min,
  Max,
  IsUUID,
  IsBoolean,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SearchDocumentsDto {
  @ApiProperty({ description: 'Search query string' })
  @IsString()
  query: string;

  @ApiPropertyOptional({ description: 'Indices to search' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  indices?: string[];

  @ApiPropertyOptional({ description: 'Entity types filter' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  entityTypes?: string[];

  @ApiPropertyOptional({ description: 'Enable highlighting', default: true })
  @IsOptional()
  @IsBoolean()
  highlights?: boolean = true;

  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Sort field', default: '_score' })
  @IsOptional()
  @IsString()
  sortBy?: string = '_score';

  @ApiPropertyOptional({ description: 'Sort order', default: 'desc', enum: ['asc', 'desc'] })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';

  @ApiPropertyOptional({ description: 'Filters' })
  @IsOptional()
  @IsObject()
  filters?: Record<string, any>;
}

export class SemanticSearchDto {
  @ApiProperty({ description: 'Search query for semantic search' })
  @IsString()
  query: string;

  @ApiPropertyOptional({ description: 'Number of results', default: 10 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  k?: number = 10;

  @ApiPropertyOptional({ description: 'Similarity threshold', default: 0.7 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  threshold?: number = 0.7;
}

export class IndexDocumentDto {
  @ApiProperty({ description: 'Entity type' })
  @IsString()
  entityType: string;

  @ApiProperty({ description: 'Entity ID' })
  @IsString()
  entityId: string;

  @ApiProperty({ description: 'Document title' })
  @IsString()
  title: string;

  @ApiProperty({ description: 'Document content' })
  @IsString()
  content: string;

  @ApiPropertyOptional({ description: 'Document metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Document tags' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class BulkIndexDto {
  @ApiProperty({ description: 'Documents to index', type: [IndexDocumentDto] })
  @IsArray()
  documents: IndexDocumentDto[];
}

export class CreateIndexDto {
  @ApiProperty({ description: 'Index name' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Entity type' })
  @IsString()
  entityType: string;

  @ApiPropertyOptional({ description: 'Index mapping (JSON)' })
  @IsOptional()
  @IsObject()
  mapping?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Number of shards', default: 1 })
  @IsOptional()
  @IsNumber()
  numberOfShards?: number = 1;

  @ApiPropertyOptional({ description: 'Number of replicas', default: 0 })
  @IsOptional()
  @IsNumber()
  numberOfReplicas?: number = 0;
}

export class UpdateMappingDto {
  @ApiProperty({ description: 'Index mapping (JSON)' })
  @IsObject()
  mapping: Record<string, any>;
}

export class SuggestQueryDto {
  @ApiProperty({ description: 'Query text for suggestions' })
  @IsString()
  text: string;

  @ApiPropertyOptional({ description: 'Field to suggest from', default: 'title' })
  @IsOptional()
  @IsString()
  field?: string = 'title';

  @ApiPropertyOptional({ description: 'Number of suggestions', default: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  size?: number = 5;
}

export class FacetedSearchDto {
  @ApiProperty({ description: 'Search query' })
  @IsString()
  query: string;

  @ApiProperty({ description: 'Facet fields' })
  @IsArray()
  @IsString({ each: true })
  facets: string[];
}

export class ReindexDto {
  @ApiProperty({ description: 'Source index' })
  @IsString()
  sourceIndex: string;

  @ApiProperty({ description: 'Destination index' })
  @IsString()
  destIndex: string;

  @ApiPropertyOptional({ description: 'Query to filter documents' })
  @IsOptional()
  @IsObject()
  query?: Record<string, any>;
}
