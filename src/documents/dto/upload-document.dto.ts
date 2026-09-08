import {
  Allow,
  IsEnum,
  IsString,
  IsOptional,
  IsBoolean,
  IsArray,
  IsObject,
  IsNumber,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentType, DocumentEncryption } from '../entities/document.entity';

export class UploadDocumentDto {
  /**
   * Declared only so Swagger renders the multipart binary part; the handler
   * reads the real file from `@UploadedFile()`, never from here.
   *
   * `@Allow()` is load-bearing, not decoration. `tsconfig` targets ES2023, so
   * `useDefineForClassFields` is on by default and TypeScript emits this
   * declaration as a genuine own property. `plainToInstance` therefore hands
   * the global ValidationPipe an object with a `file` key on it, and
   * `forbidNonWhitelisted: true` rejects any own property that carries no
   * validation metadata — so **every** upload answered
   * `400 property file should not exist`, whatever was in the request.
   *
   * `@Allow()` registers the property as whitelisted without validating it,
   * which is exactly what a field that is always `undefined` in the body needs.
   * Do not "tidy" this decorator away, and do not add an undecorated property
   * to any DTO behind `forbidNonWhitelisted`.
   */
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'File to upload',
  })
  @Allow()
  file?: unknown;

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

  /**
   * Multipart has no arrays: multer yields a string for one `tags` part and an
   * array only from two or more. Without this, uploading a document with a
   * single tag failed `tags must be an array` while the same call with two tags
   * succeeded — a bug that looks like flakiness from the browser side.
   */
  @ApiPropertyOptional({ type: [String], description: 'Document tags' })
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || Array.isArray(value) ? value : [value],
  )
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  /**
   * Multipart has no objects either — every part arrives as text — so a JSON
   * body is the only way a caller can send this alongside a file. Parsed here
   * rather than in the service so `@IsObject()` still guards the result.
   *
   * A malformed string is passed through untouched so validation reports
   * `metadata must be an object`; swallowing it into `{}` would accept the
   * upload and quietly discard whatever the caller meant to attach.
   */
  @ApiPropertyOptional({
    description: 'Additional metadata. Over multipart, send as a JSON string.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  })
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
