import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UsageType } from '../entities/usage-record.entity';

/**
 * Body for `POST /billing/plans`.
 *
 * Was `@Body() dto: any` spread straight into `repo.create()`, so a body with
 * no `name` reached the insert and 500'd on the NOT NULL constraint. Money
 * endpoints are the last place to accept unvalidated input.
 */
export class CreatePlanDto {
  @ApiProperty({ example: 'Professional' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ example: 49900, description: 'Minor units (cents).' })
  @IsOptional()
  @IsInt()
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ example: 'USD', description: 'ISO 4217' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional({ enum: ['monthly', 'quarterly', 'yearly'] })
  @IsOptional()
  @IsEnum(['monthly', 'quarterly', 'yearly'] as any)
  billingCycle?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  features?: Record<string, any>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  limits?: Record<string, any>;
}

export class CreateSubscriptionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  entityId: string;

  @ApiProperty({ example: 'tenant' })
  @IsString()
  @MaxLength(64)
  entityType: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  planId: string;

  @ApiPropertyOptional({ example: 14 })
  @IsOptional()
  @IsInt()
  @Min(0)
  trialDays?: number;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class RecordUsageDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  subscriptionId: string;

  @ApiProperty({ enum: UsageType })
  @IsEnum(UsageType)
  usageType: UsageType;

  @ApiProperty({ example: 1 })
  @IsNumber()
  // Usage is metered and billed; a negative quantity would be a refund by the
  // back door.
  @Min(0)
  quantity: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class AddCreditsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  subscriptionId: string;

  @ApiProperty({ example: 10000, description: 'Minor units (cents).' })
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiProperty({ example: 'Goodwill credit for the March outage' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
