import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PlatformRole } from '../enums/platform-role.enum';

export class InviteUserDto {
  @ApiProperty({ example: 'analyst@acme-bank.ae' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({
    enum: PlatformRole,
    default: PlatformRole.STAFF,
    description:
      'Platform role granted on acceptance. Defaults to `staff`. Vertical ' +
      'role vocabularies map onto these four in the config pack, not here.',
  })
  @IsOptional()
  @IsEnum(PlatformRole, {
    message: `role must be one of: ${Object.values(PlatformRole).join(', ')}`,
  })
  role?: PlatformRole;

  @ApiPropertyOptional({ example: 'Layla' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Rashid' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional({ example: 'Trade Finance' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  department?: string;
}
