import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentType } from '../entities/document.entity';

export class RequestDocumentUploadUrlDto {
  @ApiProperty({
    description:
      'Document name — used, the same way POST /documents does, to build ' +
      'the storage key this upload will target.',
  })
  @IsString()
  name: string;

  @ApiProperty({
    description:
      'Original file name, including extension. Used for type detection ' +
      '(when fileType is omitted) and the key\'s extension.',
  })
  @IsString()
  originalFileName: string;

  @ApiPropertyOptional({
    enum: DocumentType,
    description: 'File type (auto-detected from originalFileName if omitted)',
  })
  @IsOptional()
  @IsEnum(DocumentType)
  fileType?: DocumentType;

  @ApiPropertyOptional({ description: 'MIME type of the file to be uploaded' })
  @IsOptional()
  @IsString()
  mimeType?: string;
}
