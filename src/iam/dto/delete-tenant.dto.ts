import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for `DELETE /tenants/:id` (ADR 0009 §2.1).
 *
 * "Type the name to confirm" — the same pattern this product already uses
 * for irreversible-looking actions. `confirmSlug` must equal the tenant's
 * CURRENT slug exactly; `TenantProvisioningService.softDeleteTenant`
 * rejects a mismatch with a 400 naming what it expected, not a silent
 * no-op. No format regex here (unlike `CheckSlugDto`) — this field is
 * compared against an existing, already-valid slug, not validated as one.
 */
export class DeleteTenantDto {
  @ApiProperty({
    description:
      "The tenant's current slug, typed to confirm this is the tenant " +
      'meant for deletion.',
    example: 'acme-immigration',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(63)
  confirmSlug: string;
}
