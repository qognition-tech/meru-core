import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaymentStatus } from '../entities/payment.entity';

export class CreatePaymentDto {
  @ApiProperty({ description: 'users.id of the client who owes this' })
  @IsUUID()
  clientId: string;

  @ApiPropertyOptional({
    description: 'universal_entities.id of the case/matter this relates to',
  })
  @IsOptional()
  @IsUUID()
  entityId?: string;

  @ApiProperty({
    description:
      'Amount in MINOR units (cents/fils/pence). Integer only — a decimal ' +
      'amount is rejected rather than rounded.',
    example: 45000,
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt({ message: 'amountMinor must be an integer number of minor units' })
  @Min(1)
  // ~92,233,720,368,547 major units. Well beyond any real fee, and short of
  // the point where bigint would lose precision passing through JS.
  @Max(9_007_199_254_740_991)
  amountMinor: number;

  @ApiProperty({ example: 'AUD', description: 'ISO-4217, 3 letters' })
  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Za-z]{3}$/, { message: 'currency must be a 3-letter ISO-4217 code' })
  currency: string;

  @ApiProperty({ example: 'Subclass 482 application fee' })
  @IsString()
  @MaxLength(300)
  description: string;

  @ApiPropertyOptional({ example: 'INV-2026-0042' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  reference?: string;

  @ApiPropertyOptional({ description: 'ISO-8601 due date' })
  @IsOptional()
  @IsISO8601()
  dueDate?: string;
}

export class ListPaymentsQueryDto {
  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({
    description:
      'Filter by client. Ignored for a client-role caller, who is always ' +
      'forced to their own id.',
  })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({ description: 'Filter by case/matter' })
  @IsOptional()
  @IsUUID()
  entityId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/**
 * Record a settlement that happened outside Meru — bank transfer, terminal,
 * trust account. There is no processor call behind this; see PaymentsService
 * for why client fees deliberately do not run through the platform's Stripe.
 */
export class SettlePaymentDto {
  @ApiProperty({
    enum: PaymentStatus,
    description:
      'Target state. Transitions are constrained: paid → refunded only, and ' +
      'refunded/cancelled are terminal.',
  })
  @IsEnum(PaymentStatus)
  status: PaymentStatus;

  @ApiPropertyOptional({
    example: 'bank_transfer',
    description: 'How the money arrived. Free text — the set of methods is a firm-level concern.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  method?: string;

  @ApiPropertyOptional({ description: 'Updated human-facing reference' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  reference?: string;

  @ApiPropertyOptional({ description: 'Reconciliation note' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
