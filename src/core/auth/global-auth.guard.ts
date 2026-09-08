import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../../iam/decorators/public.decorator';

/**
 * Registered as APP_GUARD so every route is authenticated by default and a
 * route is only anonymous when it *declares* `@Public()`. Before this guard,
 * auth was opt-in per controller — a new controller that forgot
 * `@UseGuards(...)` shipped as a public endpoint.
 *
 * Routes with their own non-JWT gate (CronSecretGuard, `AuthGuard('local')`
 * on login, the SAML callback) must also carry `@Public()`: global guards run
 * before route-level guards, so without it this guard would demand a bearer
 * token the caller cannot have yet.
 */
@Injectable()
export class GlobalAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
