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
}
