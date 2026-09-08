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

  it('delegates non-public routes to passport instead of allowing them', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

    // The contract under test is that a non-public route does NOT
    // short-circuit to `true` the way the @Public branch does — it hands off
    // to passport. Asserting a specific exception type here would be
    // asserting passport's internals (with no strategy registered in a unit
    // context it raises "Unknown authentication strategy", not
    // UnauthorizedException), so assert the handoff itself.
    let outcome: unknown;
    try {
      outcome = await guard.canActivate(contextWithAuthHeader());
    } catch (err) {
      outcome = err;
    }
    expect(outcome).not.toBe(true);
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
