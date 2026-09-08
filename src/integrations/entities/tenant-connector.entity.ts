import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum ConnectorMode {
  SANDBOX = 'sandbox',
  LIVE = 'live',
}

/**
 * Per-tenant regulator connector enablement — the "connect your central bank /
 * migration authority" feature. The adapter itself (code, endpoints, auth
 * shape) is platform-global; THIS row is one tenant's relationship to it:
 * whether it's on, sandbox vs live, and the tenant's own credentials.
 *
 * `credentials` holds an AES-256-GCM envelope (see core/crypto), never
 * plaintext, and is never returned by the API — only `hasCredentials`.
 */
@Entity('tenant_connectors')
@Index(['tenantId'])
@Index(['tenantId', 'adapterCode'], { unique: true })
export class TenantConnector {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ length: 100 })
  adapterCode: string;

  @Column({ default: false })
  enabled: boolean;

  @Column({ type: 'enum', enum: ConnectorMode, default: ConnectorMode.SANDBOX })
  mode: ConnectorMode;

  @Column({ type: 'jsonb', nullable: true })
  credentials: { iv: string; tag: string; data: string } | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
