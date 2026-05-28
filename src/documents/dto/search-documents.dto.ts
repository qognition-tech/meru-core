import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsInt,
  IsBoolean,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  DocumentType,
  DocumentStatus,
  DocumentEncryption,
} from '../entities/document.entity';
import { Type } from 'class-transformer';

export class SearchDocumentsDto {
  @ApiPropertyOptional({ description: 'Search query' })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiPropertyOptional({
    enum: DocumentType,
    isArray: true,
    description: 'Filter by file types',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(DocumentType, { each: true })
  fileTypes?: DocumentType[];

  @ApiPropertyOptional({
    enum: DocumentStatus,
    description: 'Filter by status',
  })
  @IsOptional()
  @IsEnum(DocumentStatus)
  status?: DocumentStatus;

  @ApiPropertyOptional({
    enum: DocumentEncryption,
    description: 'Filter by encryption',
  })
  @IsOptional()
  @IsEnum(DocumentEncryption)
  encryption?: DocumentEncryption;

  @ApiPropertyOptional({ description: 'Filter by linked entity type' })
  @IsOptional()
  @IsString()
  linkedEntityType?: string;

  @ApiPropertyOptional({ description: 'Filter by linked entity ID' })
  @IsOptional()
  @IsString()
  linkedEntityId?: string;

  @ApiPropertyOptional({ type: [String], description: 'Filter by tags' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Search in AI analysis results' })
  @IsOptional()
  @IsBoolean()
  includeAI?: boolean;

  @ApiPropertyOptional({ description: 'Page number', minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({
    description: 'Items per page',
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional({ description: 'Sort field' })
  @IsOptional()
  @IsString()
  sortBy?: string;

  @ApiPropertyOptional({ description: 'Sort direction' })
  @IsOptional()
  @IsString()
  sortOrder?: 'ASC' | 'DESC';
}
