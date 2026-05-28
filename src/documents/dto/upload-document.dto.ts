import {
  IsEnum,
  IsString,
  IsOptional,
  IsBoolean,
  IsArray,
  IsObject,
  IsNumber,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentType, DocumentEncryption } from '../entities/document.entity';

export class UploadDocumentDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'File to upload',
  })
  file: any;

  @ApiProperty({ description: 'Document name' })
  @IsString()
  name: string;

  @ApiPropertyOptional({
    enum: DocumentType,
    description: 'File type (auto-detected if not provided)',
  })
  @IsOptional()
  @IsEnum(DocumentType)
  fileType?: DocumentType;

  @ApiPropertyOptional({
    enum: DocumentEncryption,
    description: 'Required encryption level',
  })
  @IsOptional()
  @IsEnum(DocumentEncryption)
  requiredEncryption?: DocumentEncryption;

  @ApiPropertyOptional({ description: 'Linked entity type' })
  @IsOptional()
  @IsString()
  linkedEntityType?: string;

  @ApiPropertyOptional({ description: 'Linked entity ID' })
  @IsOptional()
  @IsString()
  linkedEntityId?: string;

  @ApiPropertyOptional({ type: [String], description: 'Document tags' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Additional metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Original file name' })
  @IsOptional()
  @IsString()
  originalFileName?: string;

  @ApiPropertyOptional({ description: 'Change description for version' })
  @IsOptional()
  @IsString()
  changeDescription?: string;

  @ApiPropertyOptional({ description: 'Trigger AI analysis' })
  @IsOptional()
  @IsBoolean()
  triggerAI?: boolean;
}
