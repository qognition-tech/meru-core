import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { VerticalPolicyService } from '../core/verticals/vertical-policy.service';
import { IntegrationsController } from './integrations.controller';

/**
 * `POST /integrations/import/:mappingKey` carried the class-level
 * `@UseGuards(AuthGuard('jwt'), PolicyGuard)` and no `@Roles` — and
 * `PolicyGuard` is a no-op without one, so every authenticated role reached it,
 * `client` included.
 *
 * That is the same shape as the hole closed on `POST /crm/entities`, and worse
 * in effect: this writes `person` and `lead` rows in BULK from a caller-supplied
 * file, and the mapped fields include the email that becomes `subjectEmail` —
 * the key deciding which client owns a record. A client could have created
 * entities attributed to anyone in the tenant, a spreadsheet at a time.
 *
 * Like `crm-create-entity-authz.spec.ts`, this runs the REAL `Reflector`
 * against the REAL controller prototype rather than a stand-in, because the
 * claim under test is that `@Roles` is attached to *this route handler* — not
 * merely present somewhere in the file.
 */
describe('POST /integrations/import/:mappingKey — bulk import is admin-gated', () => {
  function contextFor(handler: unknown, user: unknown) {
    return {
      getHandler: () => handler,
      getClass: () => IntegrationsController,
      switchToHttp: () => ({
        getRequest: () => ({ user, ip: '203.0.113.11' }),
      }),
    } as any;
  }

  function buildGuard() {
    // No tenantId on any actor below, so `resolveVertical` short-circuits
    // before the policy engine is touched — this suite is about the ROLE gate.
    const verticalPolicyService = {
      getPolicy: jest.fn(),
    } as unknown as VerticalPolicyService;
    const dataSource = { query: jest.fn() } as unknown as DataSource;
    return new PolicyGuard(new Reflector(), verticalPolicyService, dataSource);
  }

  const runImport = () => IntegrationsController.prototype.runImport;
  const listMappings = () => IntegrationsController.prototype.listImportMappings;

  it('refuses a client-only token', async () => {
    await expect(
      buildGuard().canActivate(
        contextFor(runImport(), { id: 'client-a', roles: ['client'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses plain staff — bulk record creation is a firm_admin action', async () => {
    await expect(
      buildGuard().canActivate(
        contextFor(runImport(), { id: 'staff-1', roles: ['staff'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows firm_admin', async () => {
    await expect(
      buildGuard().canActivate(
        contextFor(runImport(), { id: 'admin-1', roles: ['firm_admin'] }),
      ),
    ).resolves.toBe(true);
  });

  it('allows platform_admin', async () => {
    await expect(
      buildGuard().canActivate(
        contextFor(runImport(), { id: 'op-1', roles: ['platform_admin'] }),
      ),
    ).resolves.toBe(true);
  });

  it('lets staff read the mappings, which disclose no tenant data', async () => {
    await expect(
      buildGuard().canActivate(
        contextFor(listMappings(), { id: 'staff-1', roles: ['staff'] }),
      ),
    ).resolves.toBe(true);
  });

  it('refuses a client reading the mappings', async () => {
    await expect(
      buildGuard().canActivate(
        contextFor(listMappings(), { id: 'client-a', roles: ['client'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
