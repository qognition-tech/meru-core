import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { VerticalPolicyService } from '../core/verticals/vertical-policy.service';
import { PlatformJobsController } from './platform-jobs.controller';

/**
 * `POST /platform/jobs/:job/run` (ADR 0009 §2.3) is the human-operator front
 * door onto job dispatch, and must be platform_admin only — the whole point
 * of this route existing alongside `CronSecretGuard`-gated `POST /jobs/:job`
 * is that a browser cannot hold the cron secret, not that any authenticated
 * user should be able to trigger a job run on demand.
 *
 * Runs the REAL `Reflector` against the REAL
 * `PlatformJobsController.prototype.run`, matching the pattern in
 * `operator-entitlements-authz.spec.ts` / `platform-documents-authz.spec.ts`.
 */
describe('POST /platform/jobs/:job/run — platform_admin only', () => {
  function contextFor(user: unknown) {
    return {
      getHandler: () => PlatformJobsController.prototype.run,
      getClass: () => PlatformJobsController,
      switchToHttp: () => ({
        getRequest: () => ({ user, ip: '203.0.113.14' }),
      }),
    } as any;
  }

  function buildGuard() {
    const verticalPolicyService = {
      getPolicy: jest.fn(),
    } as unknown as VerticalPolicyService;
    const dataSource = { query: jest.fn() } as unknown as DataSource;
    return new PolicyGuard(new Reflector(), verticalPolicyService, dataSource);
  }

  it('refuses a client-only token', async () => {
    await expect(
      buildGuard().canActivate(
        contextFor({ id: 'client-a', roles: ['client'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses staff', async () => {
    await expect(
      buildGuard().canActivate(
        contextFor({ id: 'staff-1', roles: ['staff'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses firm_admin — triggering a platform job is not a tenant-scoped action', async () => {
    await expect(
      buildGuard().canActivate(
        contextFor({ id: 'admin-1', roles: ['firm_admin'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows platform_admin', async () => {
    await expect(
      buildGuard().canActivate(
        contextFor({ id: 'op-1', roles: ['platform_admin'] }),
      ),
    ).resolves.toBe(true);
  });
});
