import {
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body for `POST /forms`.
 *
 * Was untyped, so a body with no `name` reached the insert and returned
 * `null value in column "name" of relation "form_schemas" violates not-null
 * constraint`.
 *
 * `fields` stays loosely typed on purpose — FORM is the JSON-schema-driven
 * module (CLAUDE.md §2 row 7) and the field vocabulary is supplied by the
 * vertical's config pack, so pinning a shape here would put vertical schema in
 * core. Requiring it to be an array is the strongest claim core can honestly
 * make.
 */
export class CreateFormDto {
  @ApiProperty({ example: 'Subclass 482 nomination' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ example: 'case', description: 'Entity the form binds to.' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  entityType: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Layout definition (sections, columns, ordering).',
  })
  @IsObject()
  layout: Record<string, any>;

  @ApiProperty({ type: 'array', items: { type: 'object' } })
  @IsArray()
  fields: Array<Record<string, any>>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  settings?: Record<string, any>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
