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
  IsDate,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StorageClass, FileAccess } from '../interfaces/storage.interface';

export class UploadFileDto {
  @ApiProperty({ description: 'File name' })
  @IsString()
  fileName: string;

  @ApiProperty({ description: 'MIME type of the file' })
  @IsString()
  mimeType: string;

  @ApiPropertyOptional({ description: 'File metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({ description: 'File tags' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Storage class', enum: StorageClass })
  @IsOptional()
  @IsEnum(StorageClass)
  storageClass?: StorageClass;

  @ApiPropertyOptional({ description: 'File access level', enum: FileAccess })
  @IsOptional()
  @IsEnum(FileAccess)
  access?: FileAccess;

  @ApiPropertyOptional({ description: 'Expiration in days' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(3650)
  expiresInDays?: number;

  @ApiPropertyOptional({ description: 'Encrypt file' })
  @IsOptional()
  encrypt?: boolean;

  @ApiPropertyOptional({ description: 'Folder path' })
  @IsOptional()
  @IsString()
  folder?: string;
}

export class UpdateFileDto {
  @ApiPropertyOptional({ description: 'File metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({ description: 'File tags' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Storage class', enum: StorageClass })
  @IsOptional()
  @IsEnum(StorageClass)
  storageClass?: StorageClass;

  @ApiPropertyOptional({ description: 'File access level', enum: FileAccess })
  @IsOptional()
  @IsEnum(FileAccess)
  access?: FileAccess;

  @ApiPropertyOptional({ description: 'File status' })
  @IsOptional()
  @IsString()
  status?: string;
}

export class CreateVersionDto {
  @ApiProperty({ description: 'Change description' })
  @IsString()
  changeDescription: string;
}

export class SearchFilesDto {
  @ApiPropertyOptional({ description: 'Search query' })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiPropertyOptional({ description: 'MIME types filter' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mimeTypes?: string[];

  @ApiPropertyOptional({ description: 'Tags filter' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Folder path filter' })
  @IsOptional()
  @IsString()
  folder?: string;

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

  @ApiPropertyOptional({ description: 'Sort by field', default: 'createdAt' })
  @IsOptional()
  @IsString()
  sortBy?: string = 'createdAt';

  @ApiPropertyOptional({ description: 'Sort order', default: 'desc' })
  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc' = 'desc';
}

export class MoveFileDto {
  @ApiProperty({ description: 'Destination folder path' })
  @IsString()
  destinationFolder: string;
}

export class CopyFileDto {
  @ApiProperty({ description: 'Destination folder path' })
  @IsString()
  destinationFolder: string;

  @ApiPropertyOptional({ description: 'New file name' })
  @IsOptional()
  @IsString()
  newName?: string;
}

export class PresignedUrlDto {
  @ApiPropertyOptional({
    description: 'URL expiration in seconds',
    default: 3600,
  })
  @IsOptional()
  @IsNumber()
  @Min(60)
  @Max(604800)
  expiresInSeconds?: number = 3600;

  @ApiPropertyOptional({
    description: 'Response disposition',
    enum: ['inline', 'attachment'],
  })
  @IsOptional()
  @IsString()
  responseDisposition?: 'inline' | 'attachment';
}

export class InitiateMultipartUploadDto {
  @ApiProperty({ description: 'File name' })
  @IsString()
  fileName: string;

  @ApiProperty({ description: 'MIME type' })
  @IsString()
  mimeType: string;

  @ApiProperty({ description: 'Total file size in bytes' })
  @IsNumber()
  @Min(1)
  totalSize: number;

  @ApiPropertyOptional({ description: 'Part size in bytes (default 100MB)' })
  @IsOptional()
  @IsNumber()
  partSize?: number;

  @ApiPropertyOptional({ description: 'File metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class CompleteMultipartUploadDto {
  @ApiProperty({ description: 'Upload ID' })
  @IsString()
  uploadId: string;

  @ApiProperty({ description: 'Part ETags', type: [String] })
  @IsArray()
  @IsString({ each: true })
  partETags: string[];
}
