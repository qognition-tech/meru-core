import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString, Matches } from 'class-validator';

/**
 * What the onboarding wizard writes at steps 2 (modules) and 7 (countries).
 *
 * The list is the complete desired state, not a delta — a PATCH-style merge
 * would make "turn this module off" unexpressible, which is how a picker ends
 * up only ever adding.
 */
export class UpdateEntitlementsDto {
  @ApiProperty({
    description:
      'Complete set of enabled modules. Capability modules must be within ' +
      "the tenant's plan; `country:XX` entries select operating countries. " +
      'Core modules are always enabled regardless of what is sent.',
    example: ['crm', 'cases', 'documents', 'forms', 'country:AU'],
    type: [String],
  })
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  // Bounded charset: these values are compared against an allowance list and
  // rendered as nav keys by three portals. Anything outside this shape is a
  // typo or an injection attempt, and neither should reach the database.
  @Matches(/^[a-z0-9_]+(:[A-Za-z0-9_-]+)?$/, {
    each: true,
    message:
      'each module must be lower_snake_case, optionally suffixed like country:AU',
  })
  modules: string[];
}
