import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantConnector } from '../entities/tenant-connector.entity';
import { IntegrationsService } from '../integrations.service';
import { VERTICAL_ADAPTERS } from './connectors.service';
import { MeruErrorCode } from '../../common/types';
import type { AuthenticatedRequest } from '../../common/types';
import type { GovernmentAdapter } from '../interfaces/government-adapter.interface';

/**
 * The single decision point for "may this tenant call this regulator
 * adapter?" — the same shape as `DocumentAccessService` and `entity-access.ts`
 * (CLAUDE.md §7.2, §5.5b): one function, not 31 hand-copied checks scattered
 * across `IntegrationsController`.
 *
 * Before this existed, every regulator handler held a directly-injected
 * adapter instance and called it with no tenant in scope at all — `enabled`
 * on `tenant_connectors` was read on exactly three paths (the settings
 * screen, the entitlements display, and the AI gateway) and none of them was
 * a regulator call. A GRC tenant could reach `/integrations/ca/visa-status`
 * and an immigration tenant could reach `/integrations/ae/str`, and a
 * disabled connector answered anyway, in one observed case with a fabricated
 * approved work permit at HTTP 200.
 *
 * Two checks, in two steps deliberately (CLAUDE.md §7.2 — an entitlement
 * grant, and a connector row, are both *data*, not code):
 *
 *   1. **Vertical.** `adapterId` must be one this tenant's vertical is allowed
 *      to reach at all — enforced unconditionally, because no tenant has ever
 *      had a legitimate reason to call another vertical's regulator. A
 *      mismatch is reported as **404**, matching the `/payments` and
 *      `document-access.service.ts` precedent: a 403 would confirm the
 *      adapter id is real, which is itself a disclosure to a tenant that
 *      should not know another vertical's regulators exist.
 *   2. **Enabled.** Only enforced where a `tenant_connectors` row exists. A
 *      **missing** row passes and logs a warning — the grant predates the
 *      connector vocabulary, the identical "ungated but logged" posture
 *      `ModuleEntitlementGuard` takes for a pre-GRC-vocabulary grant. Flipping
 *      a missing row to deny needs a reversible backfill migration, verified
 *      against a real tenant of each vertical first; until then this is the
 *      safe half of the gate. A row that exists and is `enabled: false` is a
 *      **409**, not 503/502 — this is a configuration state a retry cannot
 *      fix, unlike an adapter that ran and failed.
 */
@Injectable()
export class AdapterAccessService {
  private readonly logger = new Logger(AdapterAccessService.name);

  constructor(
    @InjectRepository(TenantConnector)
    private readonly connectorRepo: Repository<TenantConnector>,
    private readonly integrationsService: IntegrationsService,
  ) {}

  async require(
    req: AuthenticatedRequest,
    adapterId: string,
  ): Promise<GovernmentAdapter> {
    const vertical = req.tenantVertical ?? null;
    const tenantId = req.user?.tenantId;

    // Step 1 — vertical gate, unconditional. A platform-scoped caller (no
    // tenant on the token, hence no vertical) has nothing to check against;
    // the role guard upstream is their gate, same as PolicyGuard's own rule.
    if (vertical) {
      const allowed = VERTICAL_ADAPTERS[vertical] ?? [];
      if (!allowed.includes(adapterId)) {
        throw new NotFoundException(
          `No adapter registered for id '${adapterId}'`,
        );
      }
    }

    // Step 2 — enabled gate, only where there is a row to check.
    if (tenantId) {
      const row = await this.connectorRepo.findOne({
        where: { tenantId, adapterCode: adapterId },
      });

      if (!row) {
        this.logger.warn(
          `Tenant ${tenantId} has no tenant_connectors row for '${adapterId}'; ` +
            'passing ungated — the grant predates the connector vocabulary',
        );
      } else if (!row.enabled) {
        throw new HttpException(
          {
            code: MeruErrorCode.TENANT_CONNECTOR_NOT_ENABLED,
            message:
              `The '${adapterId}' connector is not enabled for this tenant. ` +
              'Enable it at /integrations/connectors before calling this route.',
            adapterId,
          },
          HttpStatus.CONFLICT,
        );
      }
    }

    return this.integrationsService.getAdapter(adapterId);
  }
}
