import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import {
  AuditAction,
  AuditSeverity,
} from '../../audit/entities/audit-log.entity';
import { TenantContext } from './tenant-context';

/**
 * The sanctioned ways to step outside a single tenant's data.
 *
 * Both paths widen what the database will return, so they are deliberately
 * narrow and noisy. `runAsGod` additionally writes an audit entry, which
 * CLAUDE.md §6.4 requires for any cross-tenant read by a human operator.
 */
@Injectable()
export class TenancyService {
  private readonly logger = new Logger(TenancyService.name);

  constructor(private readonly auditService: AuditService) {}

  /**
   * Run work that legitimately has no tenant yet.
   *
   * Valid uses are bootstrap lookups that *establish* identity — resolving a
   * user by email during login, validating an API-key hash, loading a session
   * from a refresh token — and background workers that iterate over tenants.
   * Every call site is a hole in tenant isolation, so keep this list short and
   * scope the callback to the single query that needs it.
   */
  runAsSystem<T>(reason: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.runAsSystem(reason, fn);
  }

  /**
   * Cross-tenant access by a human operator (the "god mode" of CLAUDE.md §5).
   *
   * The audit entry is written before the work runs, so an operation that
   * crashes or is killed mid-flight still leaves a record that the access was
   * attempted. Audit writes are themselves tenant-scoped, so this happens in a
   * system context — otherwise the insert would be filtered by the very policies
   * being bypassed.
   */
  async runAsGod<T>(
    actorId: string,
    targetTenantId: string,
    reason: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.logger.warn(
      `GOD MODE: actor=${actorId} tenant=${targetTenantId} reason="${reason}"`,
    );

    await TenantContext.runAsSystem('write god-mode audit entry', () =>
      this.auditService.logEvent({
        tenantId: targetTenantId,
        userId: actorId,
        action: AuditAction.READ,
        entityType: 'tenant',
        entityId: targetTenantId,
        description: `Cross-tenant (god mode) access: ${reason}`,
        severity: AuditSeverity.CRITICAL,
        context: { reason, actorId, mode: 'god' },
      }),
    ).catch((error) => {
      // If the access cannot be recorded, it does not happen. An unlogged
      // cross-tenant read is precisely what §6.4 forbids.
      this.logger.error(
        `Failed to write god-mode audit entry: ${error.message}`,
      );
      throw error;
    });

    return TenantContext.runAsGod(actorId, reason, fn);
  }
}
