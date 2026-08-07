import {
  IsArray,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ScreeningType, WatchlistEntry } from '../screening.engine';
import type { DocumentKind } from '../doc-intel.engine';

const SCREENING_TYPES = [
  'sanctions',
  'pep',
  'adverse_media',
  'watchlist',
  'criminal',
  'financial',
  'identity_verification',
  'document_verification',
] as const;

const DOCUMENT_KINDS = [
  'passport',
  'national_id',
  'payslip',
  'bank_statement',
  'employment_contract',
  'skills_assessment',
  'trade_invoice',
  'bill_of_lading',
] as const;

/** Body of `POST /engines/screening`. tenantId comes from the token, never here. */
export class ScreenRequestDto {
  @ApiPropertyOptional({ description: 'Your record id, echoed back on the result' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entityId?: string;

  @ApiProperty({ example: 'Mohammed Al-Rashid' })
  @IsString()
  @MaxLength(500)
  entityName: string;

  @ApiProperty({
    enum: ['individual', 'organization', 'vessel', 'transaction'],
    example: 'individual',
  })
  @IsIn(['individual', 'organization', 'vessel', 'transaction'])
  entityType: 'individual' | 'organization' | 'vessel' | 'transaction';

  @ApiProperty({
    isArray: true,
    enum: SCREENING_TYPES,
    example: ['sanctions', 'pep'],
  })
  @IsArray()
  @IsIn(SCREENING_TYPES, { each: true })
  screeningTypes: ScreeningType[];

  @ApiPropertyOptional({
    description:
      'Match threshold 0-1. Lower catches more (and more false positives); ' +
      'the 0.85 default is tuned for review-queue volume, not for recall.',
    minimum: 0,
    maximum: 1,
    default: 0.85,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  threshold?: number;

  @ApiPropertyOptional({
    description:
      "This tenant's own watchlist, merged with the ingested public lists " +
      'for this request only. Nothing here is persisted.',
  })
  @IsOptional()
  @IsArray()
  customWatchlist?: WatchlistEntry[];

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

/** Body of `POST /engines/doc-intel`. */
export class DocIntelRequestDto {
  @ApiProperty({ description: 'Your document id, echoed back on the result' })
  @IsString()
  @MaxLength(100)
  documentId: string;

  @ApiProperty({ enum: DOCUMENT_KINDS, example: 'passport' })
  @IsIn(DOCUMENT_KINDS)
  kind: DocumentKind;

  @ApiProperty({ example: 'image/jpeg' })
  @IsString()
  @MaxLength(100)
  mimeType: string;

  @ApiPropertyOptional({
    description: 'Base64 image bytes. Supply this OR fileUrl.',
  })
  @IsOptional()
  @IsString()
  base64Image?: string;

  @ApiPropertyOptional({
    description: 'Fetchable document URL. Supply this OR base64Image.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  fileUrl?: string;
}

/** Body of `POST /engines/vessel/risk`. At least one identifier is required. */
export class VesselRiskRequestDto {
  @ApiPropertyOptional({ example: '477995000' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  mmsi?: string;

  @ApiPropertyOptional({ example: '9395044' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  imo?: string;

  @ApiPropertyOptional({ example: 'EVER GIVEN' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  vesselName?: string;
}
