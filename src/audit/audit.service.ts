import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThan } from 'typeorm';
import {
  AuditLog,
  AuditAction,
  AuditSeverity,
  ComplianceStandard,
} from './entities/audit-log.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as crypto from 'crypto';

export interface LogAuditEventDto {
  tenantId: string;
  userId: string;
  userEmail?: string;
  userRole?: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  description?: string;
  severity?: AuditSeverity;
  beforeState?: Record<string, any>;
  afterState?: Record<string, any>;
  context?: Record<string, any>;
  complianceStandard?: ComplianceStandard;
  complianceMetadata?: Record<string, any>;
}

export interface AuditQueryDto {
  tenantId: string;
  startDate?: Date;
  endDate?: Date;
  userId?: string;
  action?: AuditAction;
  entityType?: string;
  entityId?: string;
  severity?: AuditSeverity;
  complianceStandard?: ComplianceStandard;
  limit?: number;
  offset?: number;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private auditRepo: Repository<AuditLog>,
  ) {}

  // ==================== WORM LOGGING ====================

  async logEvent(dto: LogAuditEventDto): Promise<AuditLog> {
    // Calculate changes between before and after state
    const changes = this.calculateChanges(dto.beforeState, dto.afterState);

    // Generate checksum for integrity
    const checksum = this.generateChecksum({
      tenantId: dto.tenantId,
      timestamp: new Date(),
      userId: dto.userId,
      action: dto.action,
      entityId: dto.entityId,
      beforeState: dto.beforeState,
      afterState: dto.afterState,
    });

    const auditLog = this.auditRepo.create({
      tenantId: dto.tenantId,
      vertical: dto.context?.['vertical'],
      environment: dto.context?.['environment'],
      timestamp: new Date(),
      userId: dto.userId,
      userEmail: dto.userEmail,
      userRole: dto.userRole,
      action: dto.action,
      entityType: dto.entityType,
      entityId: dto.entityId,
      description: dto.description,
      severity: dto.severity || AuditSeverity.INFO,
      beforeState: dto.beforeState || null,
      afterState: dto.afterState || null,
      changes,
      context: dto.context || {},
      complianceStandard: dto.complianceStandard,
      complianceMetadata: dto.complianceMetadata || {},
      checksum,
      archived: false,
    });

    const saved = await this.auditRepo.save(auditLog);
    this.logger.debug(`Audit log created: ${saved.id}`);

    return saved;
  }

  async logCreate(
    tenantId: string,
    userId: string,
    entityType: string,
    entityId: string,
    afterState: Record<string, any>,
    context?: Record<string, any>,
  ): Promise<AuditLog> {
    return this.logEvent({
      tenantId,
      userId,
      action: AuditAction.CREATE,
      entityType,
      entityId,
      description: `Created ${entityType}`,
      afterState,
      context,
    });
  }

  async logUpdate(
    tenantId: string,
    userId: string,
    entityType: string,
    entityId: string,
    beforeState: Record<string, any>,
    afterState: Record<string, any>,
    context?: Record<string, any>,
  ): Promise<AuditLog> {
    return this.logEvent({
      tenantId,
      userId,
      action: AuditAction.UPDATE,
      entityType,
      entityId,
      description: `Updated ${entityType}`,
      beforeState,
      afterState,
      context,
    });
  }

  async logDelete(
    tenantId: string,
    userId: string,
    entityType: string,
    entityId: string,
    beforeState: Record<string, any>,
    context?: Record<string, any>,
  ): Promise<AuditLog> {
    return this.logEvent({
      tenantId,
      userId,
      action: AuditAction.DELETE,
      entityType,
      entityId,
      description: `Deleted ${entityType}`,
      beforeState,
      context,
    });
  }

  async logWorkflowTransition(
    tenantId: string,
    userId: string,
    workflowInstanceId: string,
    fromState: string,
    toState: string,
    context?: Record<string, any>,
  ): Promise<AuditLog> {
    return this.logEvent({
      tenantId,
      userId,
      action: AuditAction.WORKFLOW_TRANSITION,
      entityType: 'workflow_instance',
      entityId: workflowInstanceId,
      description: `Workflow transitioned from ${fromState} to ${toState}`,
      beforeState: { state: fromState },
      afterState: { state: toState },
      context,
    });
  }

  async logDocumentAccess(
    tenantId: string,
    userId: string,
    documentId: string,
    action: AuditAction.READ | AuditAction.DOWNLOAD | AuditAction.SHARE,
    context?: Record<string, any>,
  ): Promise<AuditLog> {
    return this.logEvent({
      tenantId,
      userId,
      action,
      entityType: 'document',
      entityId: documentId,
      description: `Document ${action}`,
      context,
    });
  }

  // ==================== QUERY & SEARCH ====================

  async queryLogs(
    query: AuditQueryDto,
  ): Promise<{ logs: AuditLog[]; total: number }> {
    const where: any = { tenantId: query.tenantId };

    if (query.startDate && query.endDate) {
      where.timestamp = Between(query.startDate, query.endDate);
    }

    if (query.userId) {
      where.userId = query.userId;
    }

    if (query.action) {
      where.action = query.action;
    }

    if (query.entityType) {
      where.entityType = query.entityType;
    }

    if (query.entityId) {
      where.entityId = query.entityId;
    }

    if (query.severity) {
      where.severity = query.severity;
    }

    if (query.complianceStandard) {
      where.complianceStandard = query.complianceStandard;
    }

    const [logs, total] = await this.auditRepo.findAndCount({
      where,
      order: { timestamp: 'DESC' },
      take: query.limit || 100,
      skip: query.offset || 0,
    });

    return { logs, total };
  }

  async getEntityHistory(
    tenantId: string,
    entityType: string,
    entityId: string,
  ): Promise<AuditLog[]> {
    return this.auditRepo.find({
      where: { tenantId, entityType, entityId },
      order: { timestamp: 'ASC' },
    });
  }

  async getUserActivity(
    tenantId: string,
    userId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<AuditLog[]> {
    return this.auditRepo.find({
      where: {
        tenantId,
        userId,
        timestamp: Between(startDate, endDate),
      },
      order: { timestamp: 'DESC' },
    });
  }

  // ==================== INTEGRITY VERIFICATION ====================

  async verifyLogIntegrity(logId: string): Promise<boolean> {
    const log = await this.auditRepo.findOne({ where: { id: logId } });

    if (!log) {
      throw new NotFoundException('Audit log not found');
    }

    const expectedChecksum = this.generateChecksum({
      tenantId: log.tenantId,
      timestamp: log.timestamp,
      userId: log.userId,
      action: log.action,
      entityId: log.entityId,
      beforeState: log.beforeState,
      afterState: log.afterState,
    });

    return log.checksum === expectedChecksum;
  }

  async verifyTenantLogs(tenantId: string): Promise<{
    total: number;
    valid: number;
    invalid: number;
    invalidLogIds: string[];
  }> {
    const logs = await this.auditRepo.find({ where: { tenantId } });

    let valid = 0;
    let invalid = 0;
    const invalidLogIds: string[] = [];

    for (const log of logs) {
      const isValid = await this.verifyLogIntegrity(log.id);
      if (isValid) {
        valid++;
      } else {
        invalid++;
        invalidLogIds.push(log.id);
      }
    }

    return {
      total: logs.length,
      valid,
      invalid,
      invalidLogIds,
    };
  }

  // ==================== EXPORT ====================

  async exportLogs(
    tenantId: string,
    startDate: Date,
    endDate: Date,
    format: 'json' | 'csv' | 'xml',
  ): Promise<{ data: string; filename: string }> {
    const { logs } = await this.queryLogs({
      tenantId,
      startDate,
      endDate,
      limit: 10000,
    });

    let data: string;
    let filename: string;
    const timestamp = new Date().toISOString().split('T')[0];

    switch (format) {
      case 'json':
        data = JSON.stringify(logs, null, 2);
        filename = `audit_logs_${tenantId}_${timestamp}.json`;
        break;
      case 'csv':
        data = this.convertToCSV(logs);
        filename = `audit_logs_${tenantId}_${timestamp}.csv`;
        break;
      case 'xml':
        data = this.convertToXML(logs);
        filename = `audit_logs_${tenantId}_${timestamp}.xml`;
        break;
      default:
        throw new Error('Unsupported export format');
    }

    return { data, filename };
  }

  // ==================== RETENTION & ARCHIVAL ====================

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async archiveOldLogs(): Promise<void> {
    this.logger.log('Archiving old audit logs...');

    const retentionDays = 365; // 1 year
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const oldLogs = await this.auditRepo.find({
      where: {
        timestamp: LessThan(cutoffDate),
        archived: false,
      },
    });

    for (const log of oldLogs) {
      log.archived = true;
      await this.auditRepo.save(log);
    }

    this.logger.log(`Archived ${oldLogs.length} old audit logs`);
  }

  // ==================== COMPLIANCE ====================

  async getComplianceReport(
    tenantId: string,
    standard: ComplianceStandard,
    startDate: Date,
    endDate: Date,
  ): Promise<any> {
    const logs = await this.auditRepo.find({
      where: {
        tenantId,
        complianceStandard: standard,
        timestamp: Between(startDate, endDate),
      },
    });

    // Group by action
    const byAction = logs.reduce((acc, log) => {
      acc[log.action] = (acc[log.action] || 0) + 1;
      return acc;
    }, {});

    // Group by severity
    const bySeverity = logs.reduce((acc, log) => {
      acc[log.severity] = (acc[log.severity] || 0) + 1;
      return acc;
    }, {});

    // Data access statistics
    const dataAccess = logs.filter(
      (log) =>
        log.action === AuditAction.READ || log.action === AuditAction.DOWNLOAD,
    );

    return {
      standard,
      period: { start: startDate, end: endDate },
      totalEvents: logs.length,
      byAction,
      bySeverity,
      dataAccess: {
        count: dataAccess.length,
        uniqueUsers: [...new Set(dataAccess.map((l) => l.userId))].length,
        uniqueEntities: [...new Set(dataAccess.map((l) => l.entityId))].length,
      },
      integrityStatus: await this.verifyTenantLogs(tenantId),
    };
  }

  // ==================== PRIVATE HELPERS ====================

  private calculateChanges(
    before: Record<string, any> | null | undefined,
    after: Record<string, any> | null | undefined,
  ): Array<{ field: string; oldValue: any; newValue: any }> {
    const changes: Array<{ field: string; oldValue: any; newValue: any }> = [];

    if (!before || !after) {
      return changes;
    }

    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

    for (const key of allKeys) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changes.push({
          field: key,
          oldValue: before[key],
          newValue: after[key],
        });
      }
    }

    return changes;
  }

  private generateChecksum(data: any): string {
    const str = JSON.stringify(data);
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  private convertToCSV(logs: AuditLog[]): string {
    if (logs.length === 0) return '';

    const headers = [
      'timestamp',
      'userId',
      'action',
      'entityType',
      'entityId',
      'severity',
      'description',
    ];
    const rows = logs.map((log) => [
      log.timestamp.toISOString(),
      log.userId,
      log.action,
      log.entityType,
      log.entityId,
      log.severity,
      log.description || '',
    ]);

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }

  private convertToXML(logs: AuditLog[]): string {
    const entries = logs
      .map(
        (log) => `
    <entry>
      <timestamp>${log.timestamp.toISOString()}</timestamp>
      <userId>${log.userId}</userId>
      <action>${log.action}</action>
      <entityType>${log.entityType}</entityType>
      <entityId>${log.entityId}</entityId>
      <severity>${log.severity}</severity>
    </entry>
    `,
      )
      .join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<auditLog>
  ${entries}
</auditLog>`;
  }
}
