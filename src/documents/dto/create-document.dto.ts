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
import { StorageProvider } from '../../storage/interfaces/storage.interface';

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

  /**
   * The three fields returned by `POST /documents/upload-url`. Present
   * together, they finalise a direct-to-bucket upload: the browser already
   * PUT the bytes straight to the driver, and this call only records where
   * they landed as a real, readable version — a document created without
   * them (the pre-existing behaviour) has no version and no readable bytes.
   * Absent, nothing here changes from before this field existed.
   */
  @ApiPropertyOptional({
    description:
      'Storage key from POST /documents/upload-url, when finalising a ' +
      'direct-to-bucket upload. Must be present alongside storageProvider ' +
      'and storageBucket.',
  })
  @IsOptional()
  @IsString()
  storageKey?: string;

  @ApiPropertyOptional({ enum: StorageProvider })
  @IsOptional()
  @IsEnum(StorageProvider)
  storageProvider?: StorageProvider;

  @ApiPropertyOptional({ description: 'Bucket name returned alongside storageKey' })
  @IsOptional()
  @IsString()
  storageBucket?: string;
}
