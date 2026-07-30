import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PromptCategory } from '../entities/ai-prompt.entity';
import { VerticalType } from '../../iam/enums/vertical.enum';

/**
 * Bodies for the AI gateway.
 *
 * All of these were TypeScript interfaces or inline literals — erased at
 * runtime, so `ValidationPipe` had no metatype and nothing was checked. An
 * empty body reached the prompt resolver and surfaced as
 * `Prompt not found: undefined`, a 500 describing an internal lookup rather
 * than the missing field the caller actually omitted.
 */
export class ExecutePromptDto {
  @ApiProperty({
    enum: PromptCategory,
    description: 'Which family of prompt to run.',
  })
  @IsEnum(PromptCategory)
  category: PromptCategory;

  @ApiPropertyOptional({
    description:
      'Specific prompt within the category. Falls back to the vertical’s ' +
      'default when omitted.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  key?: string;

  @ApiProperty({ example: 'Summarise this applicant’s visa history.' })
  @IsString()
  @MinLength(1)
  @MaxLength(32000)
  input: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  context?: Record<string, any>;

  @ApiPropertyOptional({ enum: VerticalType })
  @IsOptional()
  @IsEnum(VerticalType)
  vertical?: VerticalType;
}

/**
 * Body for `POST /ai/analyze-entity/:id`.
 *
 * The entity's own fields are passed through to the prompt, so this stays open
 * — but `vertical` is validated, because an unknown value silently selected no
 * prompt and surfaced as `Prompt not found: entity_analysis/<junk>`.
 */
export class AnalyzeEntityDto {
  @ApiPropertyOptional({ enum: VerticalType })
  @IsOptional()
  @IsEnum(VerticalType)
  vertical?: VerticalType;

  [key: string]: unknown;
}

export class CreateEmbeddingDto {
  @ApiProperty({ example: 'Text to embed' })
  @IsString()
  @MinLength(1)
  // Roughly the practical ceiling for a single embedding call; longer input
  // should be chunked by the caller rather than silently truncated here.
  @MaxLength(32000)
  text: string;

  @ApiProperty({
    example: 'entity',
    description: 'Resource kind being embedded.',
  })
  @IsString()
  @MaxLength(64)
  type: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Resource the embedding belongs to.',
  })
  @IsString()
  @MaxLength(128)
  resourceId: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class UpsertPromptDto {
  @ApiProperty({ example: 'entity_analysis' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  key: string;

  @ApiProperty({ example: 'Analyse the following entity: {{entity}}' })
  @IsString()
  @MinLength(1)
  template: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ example: 'immigration' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  vertical?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
