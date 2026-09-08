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

  // `@IsEnum` only rejects a garbage string — it deliberately still admits
  // `platform_admin`, because a real `platform_admin` caller must be able to
  // invite one. This DTO has no idea who the caller is, so it cannot enforce
  // "at or below the caller's own privilege"; that ceiling is `canGrantRole`
  // in `IamService.inviteUser`, and it is the check that actually matters. A
  // `firm_admin` inviting `platform_admin` fails there, not here.
  @ApiPropertyOptional({
    enum: PlatformRole,
    default: PlatformRole.STAFF,
    description:
      'Platform role granted on acceptance. Defaults to `staff`. Vertical ' +
      'role vocabularies map onto these four in the config pack, not here. ' +
      'Capped server-side at the calling user’s own privilege — a ' +
      '`firm_admin` cannot invite a `platform_admin`.',
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
