import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PlatformRole } from '../enums/platform-role.enum';
import { UserStatus } from '../entities/user.entity';

/**
 * Deliberately narrow. There is no `email`, `password`, `tenantId` or MFA field
 * here, and `forbidNonWhitelisted` on the global ValidationPipe rejects them
 * outright — so a tenant admin can manage the directory but can never use this
 * route to take over an account or move a user between tenants.
 */
export class UpdateUserDto {
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

  @ApiPropertyOptional({ enum: PlatformRole })
  @IsOptional()
  @IsEnum(PlatformRole, {
    message: `role must be one of: ${Object.values(PlatformRole).join(', ')}`,
  })
  role?: PlatformRole;

  @ApiPropertyOptional({ example: 'Sanctions' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  department?: string;

  @ApiPropertyOptional({
    enum: UserStatus,
    description:
      'Use `inactive` to deactivate rather than deleting — audit history must ' +
      'keep resolving the actor. See CLAUDE.md §6.5.',
  })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}
