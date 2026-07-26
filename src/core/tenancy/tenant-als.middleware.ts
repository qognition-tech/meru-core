import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TenantContext } from './tenant-context';

/**
 * Opens the AsyncLocalStorage context for the request.
 *
 * This runs as middleware — i.e. before guards — so the JWT has not been
 * validated yet and the tenant is unknown at this point. It deliberately enters
 * the context with an *empty* store, which `TenantBindingInterceptor` fills in
 * once authentication has produced `req.user`.
 *
 * Splitting it this way is what makes the mutable `TenantStore` necessary: the
 * ALS context has to be entered at the outermost point (so everything downstream
 * shares it) but can only be populated later.
 */
@Injectable()
export class TenantAlsMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    // `next` continues the whole downstream chain inside this context.
    TenantContext.run({}, () => next());
  }
}
