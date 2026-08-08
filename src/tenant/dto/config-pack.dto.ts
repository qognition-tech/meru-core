import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsObject,
  IsOptional,
  IsSemVer,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Real classes, not interfaces — and this distinction is load-bearing.
 *
 * These were `export interface` in config-pack.service.ts, imported into the
 * controller with `import type`. TypeScript erases both, so
 * `emitDecoratorMetadata` recorded `design:paramtypes` as `Object` and
 * ValidationPipe had nothing to reflect on: it validated nothing, silently.
 * Every body was accepted verbatim and passed to the repository, which is how
 * a request carrying only unknown fields reached Postgres and returned a 500
 * from a NOT NULL constraint instead of a 400.
 *
 * That is not merely untidy on this controller. These routes are
 * platform-global config CRUD — a pack change propagates to every tenant
 * pinned to it — so "accepts arbitrary JSON" is the wrong default here more
 * than almost anywhere else in the codebase.
 *
 * The same trap is documented in tenant-provisioning.controller.ts. It is easy
 * to reintroduce, because nothing fails: validation just stops happening.
 */
export class CreateConfigPackDto {
  @ApiProperty({
    example: 'au-immigration',
    description: 'Stable identifier. Lower-case, hyphen-separated.',
  })
  @IsString()
  @MaxLength(100)
  // Matches the JSON Schema in packages/config-packs/_schema. A mismatch here
  // is what previously rejected every pack on disk (slash vs hyphen), so the
  // two must be kept in step.
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'code must be lower-case alphanumeric segments separated by hyphens',
  })
  code: string;

  @ApiProperty({ example: 'Australia — Immigration' })
  @IsString()
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ example: '1.0.0', description: 'Semantic version' })
  @IsSemVer({ message: 'version must be semver, e.g. 1.0.0' })
  version: string;

  @ApiPropertyOptional({ example: 'immigration' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  vertical?: string;

  @ApiPropertyOptional({
    description: 'The pack body — entityTypes, documentTypes, workflows, etc.',
  })
  @IsOptional()
  @IsObject()
  schema?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  defaults?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  uiConfig?: Record<string, unknown>;
}

export class PinConfigPackDto {
  @ApiProperty({ description: 'config_packs.id to pin' })
  @IsUUID()
  configPackId: string;

  @ApiProperty({ example: '1.0.0', description: 'Version to lock the tenant to' })
  @IsSemVer({ message: 'pinnedVersion must be semver, e.g. 1.0.0' })
  pinnedVersion: string;

  @ApiProperty({ description: 'User id recorded as having pinned this' })
  @IsString()
  @MaxLength(100)
  pinnedBy: string;

  @ApiPropertyOptional({
    description: 'Tenant-specific overrides merged over the pack.',
  })
  @IsOptional()
  @IsObject()
  overrides?: Record<string, unknown>;
}
