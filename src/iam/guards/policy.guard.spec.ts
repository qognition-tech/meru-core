import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { PolicyGuard } from './policy.guard';
import { VerticalPolicyService } from '../../core/verticals/vertical-policy.service';
import { VerticalType } from '../enums/vertical.enum';

const PERMISSIVE_POLICY = {
  vertical: VerticalType.GRC,
  rules: {
    mfaRequired: false,
    ipWhitelist: [] as string[],
    businessHours: { start: 0, end: 24 },
    dataRetentionDays: 1,
  },
};

function contextFor(user: unknown, ip = '203.0.113.10'): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user, ip }),
    }),
  } as unknown as ExecutionContext;
}

describe('PolicyGuard', () => {
  let reflector: Reflector;
  let policyService: jest.Mocked<Pick<VerticalPolicyService, 'getPolicy'>>;
  let dataSource: jest.Mocked<Pick<DataSource, 'query'>>;
  let guard: PolicyGuard;

  beforeEach(() => {
    reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    policyService = { getPolicy: jest.fn().mockResolvedValue(PERMISSIVE_POLICY) };
    dataSource = { query: jest.fn().mockResolvedValue([]) };
    guard = new PolicyGuard(
      reflector,
      policyService as unknown as VerticalPolicyService,
      dataSource as unknown as DataSource,
    );
  });

  it('rejects requests with no authenticated user', async () => {
    await expect(guard.canActivate(contextFor(undefined))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects when required roles are not held', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['firm_admin']);

    await expect(
      guard.canActivate(contextFor({ id: 'u1', roles: ['client'] })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows a platform-scoped user with no tenant (roles are the gate)', async () => {
    await expect(
      guard.canActivate(contextFor({ id: 'u1', roles: ['platform_admin'] })),
    ).resolves.toBe(true);
    expect(policyService.getPolicy).not.toHaveBeenCalled();
  });

  it('resolves the REAL tenant vertical from the database — no fintech default', async () => {
    dataSource.query.mockResolvedValue([
      { vertical: VerticalType.IMMIGRATION },
    ]);

    await guard.canActivate(
      contextFor({ id: 'u1', roles: ['staff'], tenantId: 'tenant-1' }),
    );

    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM tenants'),
      ['tenant-1'],
    );
    expect(policyService.getPolicy).toHaveBeenCalledWith(
      VerticalType.IMMIGRATION,
    );
  });

  it('caches the vertical lookup per tenant', async () => {
    dataSource.query.mockResolvedValue([{ vertical: VerticalType.GRC }]);
    const ctx = () =>
      contextFor({ id: 'u1', roles: ['staff'], tenantId: 'tenant-1' });

    await guard.canActivate(ctx());
    await guard.canActivate(ctx());

    expect(dataSource.query).toHaveBeenCalledTimes(1);
  });

  it('enforces an IP whitelist when the vertical policy defines one', async () => {
    dataSource.query.mockResolvedValue([{ vertical: VerticalType.GRC }]);
    policyService.getPolicy.mockResolvedValue({
      ...PERMISSIVE_POLICY,
      rules: { ...PERMISSIVE_POLICY.rules, ipWhitelist: ['198.51.100.1'] },
    });

    await expect(
      guard.canActivate(
        contextFor({ id: 'u1', roles: ['staff'], tenantId: 'tenant-1' }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
