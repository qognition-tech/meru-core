import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaymentDirection, PaymentStatus } from '../entities/payment.entity';

export class CreatePaymentDto {
  @ApiPropertyOptional({
    enum: PaymentDirection,
    default: PaymentDirection.INBOUND,
    description:
      '`inbound` (default) is what a client owes the firm. `outbound` is a ' +
      'disbursement the firm pays out — chiefly the government charge it ' +
      'forwards to the regulator, which is the other half of the lodgement ' +
      'step and previously had nowhere to be recorded.',
  })
  @IsOptional()
  @IsEnum(PaymentDirection)
  direction?: PaymentDirection;

  @ApiPropertyOptional({
    description:
      'The client who owes this — accepts EITHER their users.id OR the ' +
      'universal_entities.id (type=person) of their CRM record, since a ' +
      "client is a CRM person before they are ever invited as a user. " +
      'Resolved to a real users.id server-side, by matching email; if the ' +
      "person hasn't been invited yet the write is refused (400) rather " +
      "than silently stored under an id no client login can ever match. " +
      '**Required for `inbound`.** Optional for `outbound`: a firm-level ' +
      "expense has no client, and attributing one would put the firm's " +
      'own costs on an applicant.',
  })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({
    example: 'Department of Home Affairs',
    description:
      'Who was paid. **Required for `outbound`** — enforced by a database ' +
      'CHECK as well as here, because this table is the record of what the ' +
      'firm spent and "paid to (blank)" records nothing.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  payee?: string;

  @ApiPropertyOptional({
    enum: ['government', 'firm', 'disbursement'],
    description:
      "What kind of charge this is. A forwarded government fee and the firm's " +
      'own fee behave differently the moment a client withdraws.',
  })
  @IsOptional()
  @IsIn(['government', 'firm', 'disbursement'])
  feeKind?: 'government' | 'firm' | 'disbursement';

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
  @Matches(/^[A-Za-z]{3}$/, {
    message: 'currency must be a 3-letter ISO-4217 code',
  })
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
    enum: PaymentDirection,
    description:
      'Receivables or disbursements. Omit for both. **Ignored for a ' +
      "client-role caller**, who only ever sees `inbound` — the firm's own " +
      'expenditure is not their business even on their own matter.',
  })
  @IsOptional()
  @IsEnum(PaymentDirection)
  direction?: PaymentDirection;

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
    description:
      'How the money arrived. Free text — the set of methods is a firm-level concern.',
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

/**
 * Body for `POST /payments/schedule`.
 *
 * Fee keys rather than amounts, deliberately: the pack decides what a thing
 * costs. A caller that could name its own amount would let a UI drift from the
 * fee schedule the vertical publishes, which is the whole reason `fees[]` exists.
 */
export class ScheduleFeesDto {
  @ApiProperty({ description: 'universal_entities.id of the matter' })
  @IsUUID()
  entityId: string;

  @ApiProperty({ description: 'users.id of the client who owes these' })
  @IsUUID()
  clientId: string;

  @ApiProperty({
    description: '`fees[].key` values from the config pack',
    example: ['gov_482_primary', 'firm_professional_482'],
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  feeKeys: string[];

  @ApiPropertyOptional({
    description:
      '`paymentPlans[].key`. Omit for one payment per fee, due immediately.',
    example: 'instalments_3',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  planKey?: string;

  @ApiPropertyOptional({
    description: 'Multiplier for `per_applicant` fees.',
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  applicants?: number;

  @ApiPropertyOptional({
    description: 'Multiplier for `per_dependent` fees.',
    minimum: 0,
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50)
  dependents?: number;

  @ApiPropertyOptional({
    description: 'When instalment clocks start. Defaults to now.',
  })
  @IsOptional()
  @IsISO8601()
  startDate?: string;

  @ApiPropertyOptional({ example: 'MTR-1188' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  reference?: string;
}

/**
 * One line of `PUT /billing/fee-overrides`'s body.
 *
 * Only `feeKey`/`amountMinor`/`currency` — no `kind`, `basis`, `atStep` or
 * anything else structural. `FeeScheduleService.setOverrides` reads those
 * from the pack's own definition of the fee; a caller cannot use this to
 * relabel a fee or change what it is charged per (per-case, per-applicant).
 */
export class FeeOverrideDto {
  @ApiProperty({
    description:
      "`fees[].key` of a `kind: 'firm'` fee in the tenant's resolved pack. " +
      "Naming a government or disbursement fee, or a key the pack doesn't " +
      'define, is rejected (400).',
    example: 'firm_professional_482',
  })
  @IsString()
  @MaxLength(100)
  feeKey: string;

  @ApiProperty({
    description: 'What this firm actually charges, in MINOR units.',
    example: 280000,
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt({ message: 'amountMinor must be an integer number of minor units' })
  @Min(1)
  @Max(9_007_199_254_740_991)
  amountMinor: number;

  @ApiProperty({ example: 'AUD', description: 'ISO-4217, 3 letters' })
  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Za-z]{3}$/, {
    message: 'currency must be a 3-letter ISO-4217 code',
  })
  currency: string;
}

/**
 * Body for `PUT /billing/fee-overrides`.
 *
 * `overrides` is the **complete desired state**, not a delta — same
 * reasoning as `OperatorUpdateEntitlementsDto.modules`: a caller reverting one
 * fee to the pack default omits it from this array, and a PATCH-style merge
 * could not express that. An empty array clears every override for the
 * tenant.
 */
export class SetFeeOverridesDto {
  @ApiProperty({ type: [FeeOverrideDto], maxItems: 100 })
  @IsArray()
  // Capped for the same reason `OperatorUpdateEntitlementsDto.modules` is,
  // which this doc comment claims to mirror but did not: an uncapped array on
  // an authenticated write lets one request do unbounded work.
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => FeeOverrideDto)
  overrides: FeeOverrideDto[];
}
