import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
} from 'typeorm';
import { Tenant } from '../../iam/entities/tenant.entity';
import { User } from '../../iam/entities/user.entity';

export enum CaseStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  PENDING = 'pending',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
  ARCHIVED = 'archived',
}

export enum CasePriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  URGENT = 'urgent',
}

@Entity('cases')
@Index(['tenantId', 'caseNumber'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'priority', 'dueDate'])
@Index(['assignedTo'])
export class Case {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Tenant, { eager: false })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({ name: 'case_number', length: 50 })
  caseNumber: string;

  @Column({ name: 'case_type', length: 50 })
  caseType: string;

  @Column({ length: 500 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({
    type: 'varchar',
    length: 30,
    default: CaseStatus.OPEN,
  })
  status: CaseStatus;

  @Column({
    type: 'varchar',
    length: 20,
    default: CasePriority.MEDIUM,
  })
  priority: CasePriority;

  @Column({ name: 'assigned_to', type: 'uuid', nullable: true })
  assignedTo: string;

  @ManyToOne(() => User, { eager: false })
  @JoinColumn({ name: 'assigned_to' })
  assignee: User;

  @Column({ name: 'case_data', type: 'jsonb', default: {} })
  caseData: Record<string, any>;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, any>;

  @Column({ name: 'due_date', type: 'timestamptz', nullable: true })
  dueDate: Date;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deletedAt: Date;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy: string;

  @ManyToOne(() => User, { eager: false })
  @JoinColumn({ name: 'created_by' })
  creator: User;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
