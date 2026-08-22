import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ModuleEntitlementException,
  ModuleEntitlementGuard,
} from './module-entitlement.guard';
import { ModuleCode } from './module-code';

describe('ModuleEntitlementGuard', () => {
  const query = jest.fn();
  let guard: ModuleEntitlementGuard;
  let required: ModuleCode[] | undefined;

  const ctx = (tenantId?: string): ExecutionContext =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user: tenantId ? { tenantId } : undefined }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    query.mockReset();
    const reflector = {
      getAllAndOverride: () => required,
    } as unknown as Reflector;
    guard = new ModuleEntitlementGuard(reflector, { query } as never);
  });

  it('passes routes that declare no module', async () => {
    required = undefined;
    await expect(guard.canActivate(ctx('t1'))).resolves.toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('passes platform-scoped callers with no tenant', async () => {
    required = [ModuleCode.SCREENING];
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it('allows a pre-vocabulary grant ungated — the ImmiStack safeguard', async () => {
    required = [ModuleCode.TRADE_FINANCE];
    query.mockResolvedValue([
      { modules: ['crm', 'cases', 'forms', 'ai_automation'] },
    ]);
    // A live immigration-era grant must keep resolving exactly as it did
    // before this guard existed (CLAUDE.md §7.2).
    await expect(guard.canActivate(ctx('t1'))).resolves.toBe(true);
  });

  it('returns 402 when a GRC-vocabulary grant lacks the module', async () => {
    required = [ModuleCode.TRADE_FINANCE];
    query.mockResolvedValue([{ modules: ['crm', 'screening'] }]);
    await expect(guard.canActivate(ctx('t2'))).rejects.toBeInstanceOf(
      ModuleEntitlementException,
    );
    try {
      await guard.canActivate(ctx('t2'));
    } catch (e) {
      expect((e as ModuleEntitlementException).getStatus()).toBe(402);
      expect((e as ModuleEntitlementException).getResponse()).toMatchObject({
        missingModules: ['trade_finance'],
      });
    }
  });

  it('passes when the GRC grant includes the module', async () => {
    required = [ModuleCode.SCREENING];
    query.mockResolvedValue([{ modules: ['crm', 'screening'] }]);
    await expect(guard.canActivate(ctx('t3'))).resolves.toBe(true);
  });

  it('caches the grant per tenant', async () => {
    required = [ModuleCode.SCREENING];
    query.mockResolvedValue([{ modules: ['screening'] }]);
    await guard.canActivate(ctx('t4'));
    await guard.canActivate(ctx('t4'));
    expect(query).toHaveBeenCalledTimes(1);
  });
});
