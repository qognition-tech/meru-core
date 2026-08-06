import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GlobalAuthGuard } from './global-auth.guard';

function contextWithAuthHeader(authorization?: string): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ headers: authorization ? { authorization } : {} }),
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

describe('GlobalAuthGuard', () => {
  let reflector: Reflector;
  let guard: GlobalAuthGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new GlobalAuthGuard(reflector);
  });

  it('allows a route marked @Public without any token', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

    expect(guard.canActivate(contextWithAuthHeader())).toBe(true);
  });

  it('delegates non-public routes to passport JWT (anonymous is rejected)', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

    // No token, no passport strategy registered in this unit context — the
    // passport path must reject; the essential contract is that it does NOT
    // short-circuit to `true` the way the @Public branch does.
    await expect(
      Promise.resolve(guard.canActivate(contextWithAuthHeader())),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('checks @Public metadata on both handler and class', () => {
    const spy = jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(true);
    const context = contextWithAuthHeader();

    guard.canActivate(context);

    expect(spy).toHaveBeenCalledWith('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
  });
});
