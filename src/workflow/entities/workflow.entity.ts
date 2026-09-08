import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { WorkflowState } from './workflow-state.entity';
import { WorkflowTransition } from './workflow-transition.entity';

export enum WorkflowStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  DRAFT = 'draft',
  ARCHIVED = 'archived',
}

export enum WorkflowTrigger {
  MANUAL = 'manual',
  AUTOMATIC = 'automatic',
  SCHEDULED = 'scheduled',
  EVENT = 'event',
}

@Entity('workflows')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'entityType'])
export class Workflow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column()
  entityType: string; // e.g., 'document', 'entity', 'task'

  @Column({ type: 'enum', enum: WorkflowStatus, default: WorkflowStatus.DRAFT })
  status: WorkflowStatus;

  @Column({
    type: 'enum',
    enum: WorkflowTrigger,
    default: WorkflowTrigger.MANUAL,
  })
  trigger: WorkflowTrigger;

  @Column({ type: 'jsonb', default: {} })
  triggerConfig: {
    eventName?: string;
    schedule?: string;
    conditions?: Record<string, any>;
  };

  @Column({ type: 'int', default: 1 })
  version: number;

  @OneToMany(() => WorkflowState, (state) => state.workflow, { cascade: true })
  states: WorkflowState[];

  @OneToMany(() => WorkflowTransition, (transition) => transition.workflow, {
    cascade: true,
  })
  transitions: WorkflowTransition[];

  @Column({ type: 'jsonb', default: {} })
  slaConfig: {
    enabled: boolean;
    defaultSLA: number; // hours
    escalationLevels: Array<{
      level: number;
      threshold: number;
      action: string;
      notify: string[];
    }>;
  };

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  deletedAt: Date;
}
