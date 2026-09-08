import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { Workflow } from './workflow.entity';
import { WorkflowState } from './workflow-state.entity';

export enum InstanceStatus {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  SUSPENDED = 'suspended',
  ERROR = 'error',
}

@Entity('workflow_instances')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'entityId'])
@Index(['workflowId', 'status'])
export class WorkflowInstance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column()
  workflowId: string;

  @ManyToOne(() => Workflow)
  @JoinColumn({ name: 'workflowId' })
  workflow: Workflow;

  @Column()
  entityId: string; // ID of the entity being processed (document, CRM entity, etc.)

  @Column()
  entityType: string;

  @Column()
  currentStateId: string;

  @ManyToOne(() => WorkflowState)
  @JoinColumn({ name: 'currentStateId' })
  currentState: WorkflowState;

  @Column({
    type: 'enum',
    enum: InstanceStatus,
    default: InstanceStatus.ACTIVE,
  })
  status: InstanceStatus;

  @Column({ type: 'jsonb', default: {} })
  context: Record<string, any>; // Dynamic data during workflow execution

  @Column({ type: 'jsonb', default: [] })
  history: Array<{
    timestamp: Date;
    fromState: string;
    toState: string;
    transitionId: string;
    triggeredBy: string;
    context: Record<string, any>;
  }>;

  @Column({ type: 'timestamp', nullable: true })
  stateEnteredAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  slaDeadline: Date | null;

  @Column({ type: 'int', default: 0 })
  escalationLevel: number;

  @Column({ type: 'jsonb', default: {} })
  slaViolations: Array<{
    level: number;
    timestamp: Date;
    action: string;
  }>;

  @Column()
  startedBy: string;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
