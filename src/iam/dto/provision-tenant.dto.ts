import {
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenantPlan, TenantStatus, VerticalType } from '../entities/tenant.entity';

// TenantStatus re-referenced so suspend/resume route docs and this DTO share
// the entity enums — see create-tenant.dto.ts for why these stay classes.
export { TenantStatus };

/** Body of `POST /tenants` — admin-provisioned creation (no password; invite flow). */
export class ProvisionTenantDto {
  @ApiProperty({ example: 'Al-Mansoori Compliance' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'mansoori-compliance' })
  @IsString()
  @MinLength(3)
  @MaxLength(63)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'slug must be lowercase alphanumeric with single hyphens between segments',
  })
  slug: string;

  @ApiProperty({ enum: VerticalType, example: VerticalType.GRC })
  @IsEnum(VerticalType)
  vertical: VerticalType;

  @ApiPropertyOptional({ enum: TenantPlan, default: TenantPlan.FREE })
  @IsOptional()
  @IsEnum(TenantPlan)
  plan?: TenantPlan;

  @ApiProperty({ example: 'admin@mansoori.ae' })
  @IsEmail()
  adminEmail: string;

  @ApiPropertyOptional({ example: 'Huda' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  adminFirstName?: string;

  @ApiPropertyOptional({ example: 'Al-Mansoori' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  adminLastName?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Extra module grants on top of the plan defaults',
    example: ['country:AE', 'ai_automation'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  modules?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Regulator connectors pre-enabled in sandbox',
    example: ['uae-central-bank', 'sa-sama'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  connectors?: string[];
}
