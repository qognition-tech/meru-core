import { SetMetadata } from '@nestjs/common';
import type { ModuleCode } from './module-code';

export const REQUIRES_MODULE_KEY = 'requiresModule';

/**
 * Declare that a route needs a module entitlement. Enforced by
 * `ModuleEntitlementGuard`, which must be listed in `@UseGuards` after the
 * JWT guard — the decorator alone changes nothing.
 *
 * Apply to routes that belong to one vertical. Never retrofit onto a route
 * ImmiStack already calls (CLAUDE.md §7.2).
 */
export const RequiresModule = (...modules: ModuleCode[]) =>
  SetMetadata(REQUIRES_MODULE_KEY, modules);
