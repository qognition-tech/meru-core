import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { PolicyGuard } from './guards/policy.guard';
import { VerticalPolicyService } from '../core/verticals/vertical-policy.service';
import { PlatformDocumentsController } from './platform-documents.controller';

/**
 * `GET /platform/tenants/:id/documents` (ADR 0009 §2.3) is a cross-tenant
 * metadata read and must be platform_admin only — `firm_admin`/`staff` of
 * ANY tenant, including the target's own, must not reach it, because this is
 * the God View path, not a scoped read of the caller's own documents.
 *
 * Runs the REAL `Reflector` against the REAL
 * `PlatformDocumentsController.prototype.documents`, matching the pattern in
 * `operator-entitlements-authz.spec.ts` / `crm-create-entity-authz.spec.ts` —
 * the claim under test is that `@Roles` is attached to *this* handler.
 */
describe('GET /platform/tenants/:id/documents — platform_admin only', () => {
  function contextFor(user: unknown) {
    return {
      getHandler: () => PlatformDocumentsController.prototype.documents,
      getClass: () => PlatformDocumentsController,
      switchToHttp: () => ({
        getRequest: () => ({ user, ip: '203.0.113.13' }),
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

  it('refuses staff, even staff of the target tenant', async () => {
    await expect(
      buildGuard().canActivate(
        contextFor({ id: 'staff-1', roles: ['staff'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses firm_admin — an operator inventory is not a scoped self-read', async () => {
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
