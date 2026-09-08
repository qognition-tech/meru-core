import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * The operator twin of `UpdateEntitlementsDto` — same complete-desired-state
 * shape and the same charset guard, plus a mandatory `reason`.
 *
 * `modules` deliberately carries no plan ceiling here (ADR 0009 §2.2):
 * `TenantProvisioningService.updateEntitlementsAsOperator` is the one place
 * that difference is enforced, not this DTO — the shape of "what a module
 * list may contain" is identical for both callers, only the allowance check
 * differs.
 *
 * `reason` is required, minimum 10 characters — the same bar `ImpersonateDto`
 * sets, because this *is* the audit record for a manual override, not
 * decoration on it (CLAUDE.md §6.4).
 */
export class OperatorUpdateEntitlementsDto {
  @ApiProperty({
    description:
      'Complete set of enabled modules for this tenant. No plan ceiling — ' +
      'this is the operator override route. `country:XX` entries select ' +
      'operating countries. Core modules are always enabled regardless of ' +
      'what is sent.',
    example: ['crm', 'cases', 'documents', 'sso', 'country:AU'],
    type: [String],
  })
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Matches(/^[a-z0-9_]+(:[A-Za-z0-9_-]+)?$/, {
    each: true,
    message:
      'each module must be lower_snake_case, optionally suffixed like country:AU',
  })
  modules: string[];

  @ApiProperty({
    description:
      'Why this override is being granted. Written to the audit log under ' +
      'the target tenant — it is the only record of why a customer has a ' +
      'module its plan does not include.',
    example: 'Ticket MER-5102 — comping sso for pilot tenant per sales',
    minLength: 10,
    maxLength: 300,
  })
  @IsString()
  @MinLength(10, {
    message:
      'reason must be at least 10 characters — it is the audit record for ' +
      "overriding a tenant's entitlements",
  })
  @MaxLength(300)
  reason: string;
}
