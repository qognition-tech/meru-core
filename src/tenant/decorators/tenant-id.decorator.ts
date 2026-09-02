import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * The authenticated caller's tenant, and nothing else.
 *
 * Used to read `request.user?.tenantId || request.headers['x-tenant-id']`.
 * The JWT claim is non-nullable today so the `||` never actually fell through
 * in production, but a header fallback on a tenant identifier is a
 * cross-tenant escape waiting for the day the claim *is* absent — a token
 * minted before the field existed, a bootstrap path, a bug. `X-Tenant-ID` is a
 * request header, which is caller-controlled; deriving tenancy from it, even
 * as a fallback, is exactly the shape CLAUDE.md §8 warns against. `grep -rn
 * x-tenant-id src` before this change found no route relying on the header
 * for tenant resolution — `main.ts` only allow-lists it for CORS and logs it
 * for an anonymous request id, and `swagger.ts` documents it as accepted;
 * neither reads it back out. The header itself is left alone; only this
 * decorator's fallback is removed.
 */
export const TenantId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user?.tenantId;
  },
);
