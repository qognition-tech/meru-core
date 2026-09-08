import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { Tenant } from '../iam/entities/tenant.entity';
import { TenantContext } from '../core/tenancy/tenant-context';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';

interface ComplianceSection {
  retentionYears?: number;
  dataResidency?: string;
}

export interface RetentionSweepResult {
  tenants: number;
  /** Per tenant: what its pack declares, and what was actually archived. */
  applied: Array<{
    tenantId: string;
    vertical: string;
    retentionYears: number | null;
    cutoff: string | null;
    archived: number;
    reason?: string;
  }>;
}

/**
 * Enforces `compliance.retentionYears` from the vertical's config pack.
 *
 * The field has been declared in every pack since the schema was written and
 * enforced nowhere — which is the worst version of a retention policy, because
 * the platform states a retention period to a regulator and does not keep it.
 *
 * **Archives, never deletes.** `audit_logs` is append-only by database trigger
 * (CLAUDE.md §5.4) and `archived` is the single column the trigger permits to
 * change; a retention sweep that tried to DELETE would be refused by Postgres,
 * and one that could delete would have punched a hole in the tamper-evidence
 * the audit log exists to provide. Archived rows leave the default query path
 * and stay available for export.
 *
 * Runs from `/jobs/tick?scope=daily`.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    private readonly packs: VerticalPackService,
  ) {}

  async sweep(): Promise<RetentionSweepResult> {
    return TenantContext.runAsSystem('retention sweep', async () => {
      const tenants = await this.tenants.find({
        select: ['id', 'vertical'],
      });

      const applied: RetentionSweepResult['applied'] = [];

      for (const tenant of tenants) {
        const compliance = await this.packs.section<ComplianceSection>(
          tenant.vertical,
          'compliance',
        );
        const years = compliance?.retentionYears ?? null;

        if (!years || years <= 0) {
          // No declared period is not "keep nothing" — it is "the pack has not
          // said", and a sweep that guessed would destroy a tenant's history
          // on the strength of an omission.
          applied.push({
            tenantId: tenant.id,
            vertical: tenant.vertical,
            retentionYears: null,
            cutoff: null,
            archived: 0,
            reason: 'pack declares no retentionYears',
          });
          continue;
        }

        const cutoff = new Date();
        cutoff.setFullYear(cutoff.getFullYear() - years);

        const result = await this.auditLogs.update(
          {
            tenantId: tenant.id,
            timestamp: LessThan(cutoff),
            archived: false,
          },
          { archived: true },
        );

        const archived = result.affected ?? 0;
        if (archived > 0) {
          this.logger.log(
            `Retention: archived ${archived} audit rows for tenant ${tenant.id} ` +
              `older than ${years}y (before ${cutoff.toISOString()})`,
          );
        }

        applied.push({
          tenantId: tenant.id,
          vertical: tenant.vertical,
          retentionYears: years,
          cutoff: cutoff.toISOString(),
          archived,
        });
      }

      return { tenants: tenants.length, applied };
    });
  }
}
