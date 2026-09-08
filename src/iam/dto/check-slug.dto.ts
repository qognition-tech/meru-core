import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body for `POST /tenants/check-slug`.
 *
 * Read via `@Body('slug')` with no DTO, so a body without `slug` passed
 * `undefined` to the availability check and reported the slug as free. The
 * caller then attempted signup and hit a different error entirely.
 *
 * The pattern matches CreateTenantDto so this endpoint cannot report a slug
 * available that signup would then reject.
 */
export class CheckSlugDto {
  @ApiProperty({ example: 'acme-immigration' })
  @IsString()
  @MinLength(3)
  @MaxLength(63)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'slug must be lowercase alphanumeric with single hyphens between segments',
  })
  slug: string;
}
