import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One configurable attribute on the vertical's subject record. */
export class VerticalSchemaFieldDto {
  @ApiProperty({ example: 'taxId' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  key: string;

  @ApiProperty({ enum: ['text', 'number', 'date', 'select'] })
  @IsEnum(['text', 'number', 'date', 'select'] as any)
  type: 'text' | 'number' | 'date' | 'select';

  @ApiProperty({ example: 'Tax ID' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  required: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  options?: string[];
}

/**
 * Body for `POST /tenant/settings`.
 *
 * `VerticalConfig` is a TypeScript interface, erased at runtime — so
 * `ValidationPipe` had no metatype and this endpoint accepted any object at
 * all, including one made entirely of unknown fields, and wrote it to
 * `tenant_settings`. That config drives required-field enforcement on every
 * entity the tenant subsequently creates, so junk written here breaks CRM
 * writes later and far from the cause.
 *
 * `fields` is validated element-by-element via `@ValidateNested`. Without it
 * class-validator checks only that the value is an array and lets malformed
 * members straight through.
 */
export class VerticalConfigDto {
  @ApiProperty({ example: 'immigration' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  vertical: string;

  @ApiProperty({
    example: 'Client',
    description: 'What this vertical calls its subject record.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  entityName: string;

  @ApiProperty({ type: [VerticalSchemaFieldDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VerticalSchemaFieldDto)
  fields: VerticalSchemaFieldDto[];
}
