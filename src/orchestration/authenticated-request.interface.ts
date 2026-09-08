import { Request } from 'express';

/**
 * Shape of the authenticated user injected onto the request by the JWT
 * Passport strategy (see iam/strategies/jwt.strategy.ts).
 *
 * Defined locally within the owned module surface to avoid an unsafe `any`
 * on `@Request() req` in controllers.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  tenantId: string;
  roles: string[];
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
  /**
   * The tenant's vertical, resolved and attached by `PolicyGuard` so callers
   * do not repeat the lookup (see policy.guard.ts:53). Present on any route
   * guarded by `PolicyGuard`, absent otherwise — which is why it is optional
   * and why a consumer must have an answer for `undefined` rather than
   * assuming a default vertical.
   */
  tenantVertical?: string;
}
