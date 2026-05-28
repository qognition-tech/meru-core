import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum AuditAction {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  READ = 'read',
  LOGIN = 'login',
  LOGOUT = 'logout',
  EXPORT = 'export',
  DOWNLOAD = 'download',
  SHARE = 'share',
  APPROVE = 'approve',
  REJECT = 'reject',
  WORKFLOW_TRANSITION = 'workflow_transition',
}

export enum AuditSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

export enum ComplianceStandard {
  GDPR = 'gdpr',
  HIPAA = 'hipaa',
  SOX = 'sox',
  PCI_DSS = 'pci_dss',
  ISO27001 = 'iso27001',
}

@Entity('audit_logs')
@Index(['tenantId', 'timestamp'])
@Index(['tenantId', 'entityType', 'entityId'])
@Index(['tenantId', 'userId'])
@Index(['tenantId', 'action'])
@Index(['tenantId', 'complianceStandard'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column()
  timestamp: Date;

  @Column()
  userId: string;

  @Column({ nullable: true })
  userEmail: string;

  @Column({ nullable: true })
  userRole: string;

  @Column({ type: 'enum', enum: AuditAction })
  action: AuditAction;

  @Column()
  entityType: string;

  @Column()
  entityId: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'enum', enum: AuditSeverity, default: AuditSeverity.INFO })
  severity: AuditSeverity;

  @Column({ type: 'jsonb' })
  beforeState: Record<string, any> | null;

  @Column({ type: 'jsonb' })
  afterState: Record<string, any> | null;

  @Column({ type: 'jsonb', default: {} })
  changes: Array<{
    field: string;
    oldValue: any;
    newValue: any;
  }>;

  @Column({ type: 'jsonb', default: {} })
  context: {
    ipAddress?: string;
    userAgent?: string;
    sessionId?: string;
    requestId?: string;
    apiEndpoint?: string;
    httpMethod?: string;
    geoLocation?: {
      country?: string;
      city?: string;
      latitude?: number;
      longitude?: number;
    };
    deviceInfo?: {
      type?: string;
      os?: string;
      browser?: string;
    };
  };

  @Column({ type: 'enum', enum: ComplianceStandard, nullable: true })
  complianceStandard: ComplianceStandard;

  @Column({ type: 'jsonb', default: {} })
  complianceMetadata: {
    dataClassification?: 'public' | 'internal' | 'confidential' | 'restricted';
    retentionPeriod?: number; // Days
    legalHold?: boolean;
    exemptionReason?: string;
  };

  @Column({ type: 'text', nullable: true })
  checksum: string; // SHA256 of this event's payload (for single-row verification)

  // Hash chain fields — WORM tamper-evidence per CLAUDE.md §6.5.
  // chainHash = SHA256(previousChainHash + tenantId + timestamp.toISO() + action + entityId + userId + checksum)
  // The first log for a tenant uses the genesis hash as previousChainHash.
  @Column({ type: 'char', length: 64, nullable: true })
  previousChainHash: string; // chainHash of the immediately prior log for this tenant

  @Column({ type: 'char', length: 64, nullable: true })
  chainHash: string; // this log's position in the chain

  @Column({ default: false })
  archived: boolean;

  @CreateDateColumn()
  createdAt: Date;

  // WORM (Write Once, Read Many) - No update method, only insert
}
