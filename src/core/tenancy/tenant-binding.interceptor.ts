import {
  CallHandler,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { UserPayload } from '../../common/types';
import { TenantContext } from './tenant-context';

/**
 * Copies the authenticated tenant into the ALS store.
 *
 * Interceptors run after guards, so `req.user` is populated by the time this
 * executes — which is precisely why the tenant cannot be resolved in the
 * middleware that opened the context.
 *
 * Unauthenticated (`@Public()`) routes simply leave the tenant unset. That is
 * safe by construction: an unbound connection matches no rows, so a public
 * handler that reaches for tenant data gets nothing rather than everything.
 */
@Injectable()
export class TenantBindingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantBindingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<{ user?: UserPayload }>();
    const tenantId = request?.user?.tenantId;

    if (tenantId) {
      const bound = TenantContext.setTenantId(tenantId);

      if (!bound) {
        // No ALS store means TenantAlsMiddleware did not run for this route.
        // Continuing would execute the request against an unbound connection,
        // so refuse rather than silently degrade tenant isolation.
        this.logger.error(
          'Tenant context missing — TenantAlsMiddleware did not run for this route.',
        );
        throw new InternalServerErrorException('Tenant context unavailable');
      }
    }

    return next.handle();
  }
}
