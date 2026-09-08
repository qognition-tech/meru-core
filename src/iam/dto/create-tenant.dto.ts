import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
// Both from the entity on purpose: these two enums define the actual Postgres
// column types. `../enums/vertical.enum` is a wider policy-lookup superset and
// validating against it would let `fintech`/`legal` through to an insert the
// database rejects — a 500 instead of a 400.
import { TenantPlan, VerticalType } from '../entities/tenant.entity';

/**
 * Body of `POST /tenants/signup`.
 *
 * This must stay a **class**. It was a TypeScript `interface`, which is erased
 * at compile time — `ValidationPipe` had no metatype to reflect on, so neither
 * `whitelist` nor `forbidNonWhitelisted` could apply and a malformed body
 * reached the service unchecked. Signup then either 500'd or half-created a
 * tenant, leaving an orphan row behind.
 */
export class CreateTenantDto {
  @ApiProperty({ example: 'Acme Immigration' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({
    example: 'acme-immigration',
    description:
      'URL-safe workspace identifier. Lowercase letters, digits and single ' +
      'hyphens only — it becomes part of the tenant hostname.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(63)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'slug must be lowercase alphanumeric with single hyphens between segments',
  })
  slug: string;

  @ApiProperty({ enum: VerticalType, example: VerticalType.IMMIGRATION })
  @IsEnum(VerticalType, {
    message: `vertical must be one of: ${Object.values(VerticalType).join(', ')}`,
  })
  vertical: VerticalType;

  @ApiPropertyOptional({ enum: TenantPlan, default: TenantPlan.FREE })
  @IsOptional()
  @IsEnum(TenantPlan)
  plan?: TenantPlan;

  @ApiProperty({ example: 'Layla' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName: string;

  @ApiProperty({ example: 'Rashid' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName: string;

  @ApiProperty({ example: 'layla@acme-immigration.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'a-strong-password', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}
