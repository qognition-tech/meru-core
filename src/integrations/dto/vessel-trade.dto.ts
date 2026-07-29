import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EntityStatus } from '../../crm/entities/universal-entity.entity';

export class AddVesselDto {
  @ApiPropertyOptional({ example: 'Gulf Star I' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    example: '9234567',
    description: 'IMO number — 7 digits. Either this or `mmsi` is required.',
  })
  // Required only when no MMSI is given: a vessel with neither identifier
  // cannot be looked up on AIS, so watching it would be meaningless.
  @ValidateIf((o) => !o.mmsi)
  @IsString()
  @Matches(/^(IMO)?\d{7}$/i, {
    message: 'imo must be 7 digits, optionally prefixed with "IMO"',
  })
  imo?: string;

  @ApiPropertyOptional({
    example: '470123456',
    description: 'MMSI — 9 digits. Either this or `imo` is required.',
  })
  @ValidateIf((o) => !o.imo)
  @IsString()
  @Matches(/^\d{9}$/, { message: 'mmsi must be exactly 9 digits' })
  mmsi?: string;

  @ApiPropertyOptional({ example: 'AE', description: 'ISO 3166-1 alpha-2' })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  flag?: string;

  @ApiPropertyOptional({ example: 'Bulk Carrier' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vesselType?: string;
}

/** Letter of credit, guarantee, documentary collection. */
export class TradeInstrumentBodyDto {
  @ApiPropertyOptional({
    example: 'LC',
    enum: ['LC', 'SBLC', 'GUARANTEE', 'COLLECTION'],
  })
  @IsOptional()
  @IsIn(['LC', 'SBLC', 'GUARANTEE', 'COLLECTION'])
  type?: string;

  @ApiPropertyOptional({ example: 'Acme Trading LLC' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  applicant?: string;

  @ApiPropertyOptional({ example: 'Orient Shipping FZE' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  beneficiary?: string;

  @ApiPropertyOptional({ example: 2500000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  amount?: number;

  @ApiPropertyOptional({ example: 'USD', description: 'ISO 4217' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiPropertyOptional({
    enum: EntityStatus,
    description:
      'Generic lifecycle state. The banking vocabulary (ISSUED, ADVISED, ' +
      'SETTLED) maps onto these in the GovernanceX config pack.',
  })
  @IsOptional()
  @IsIn(Object.values(EntityStatus))
  status?: string;

  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @IsDateString()
  issuedDate?: string;

  @ApiPropertyOptional({ example: '2026-11-30' })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @ApiPropertyOptional({ example: 'AE', description: 'ISO 3166-1 alpha-2' })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  country?: string;

  @ApiPropertyOptional({
    example: '9234567',
    description:
      'Carrying vessel. Links the instrument to the vessel watchlist so a ' +
      'sanctioned-port call can be tied back to the trade it financed.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^(IMO)?\d{7}$/i)
  vesselImo?: string;
}
