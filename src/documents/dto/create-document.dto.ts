import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsArray,
  IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DocumentType,
  DocumentEncryption,
  DocumentStatus,
} from '../entities/document.entity';

export class CreateDocumentDto {
  @ApiProperty({ description: 'Document name' })
  @IsString()
  name: string;

  @ApiProperty({ enum: DocumentType, description: 'File type' })
  @IsEnum(DocumentType)
  fileType: DocumentType;

  @ApiProperty({ description: 'Original file name' })
  @IsString()
  originalFileName: string;

  @ApiProperty({ description: 'File size in bytes' })
  @IsNumber()
  fileSize: number;

  @ApiPropertyOptional({ description: 'MIME type' })
  @IsOptional()
  @IsString()
  mimeType?: string;

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

  @ApiPropertyOptional({ description: 'Change description for version' })
  @IsOptional()
  @IsString()
  changeDescription?: string;
}
