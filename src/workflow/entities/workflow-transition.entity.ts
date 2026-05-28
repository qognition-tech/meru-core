import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Workflow } from './workflow.entity';
import { WorkflowState } from './workflow-state.entity';

export enum TransitionType {
  AUTOMATIC = 'automatic',
  MANUAL = 'manual',
  CONDITIONAL = 'conditional',
  SCHEDULED = 'scheduled',
}

@Entity('workflow_transitions')
@Index(['workflowId', 'fromStateId'])
@Index(['workflowId', 'toStateId'])
export class WorkflowTransition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  workflowId: string;

  @ManyToOne(() => Workflow, (workflow) => workflow.transitions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'workflowId' })
  workflow: Workflow;

  @Column()
  fromStateId: string;

  @ManyToOne(() => WorkflowState, (state) => state.outgoingTransitions)
  @JoinColumn({ name: 'fromStateId' })
  fromState: WorkflowState;

  @Column()
  toStateId: string;

  @ManyToOne(() => WorkflowState, (state) => state.incomingTransitions)
  @JoinColumn({ name: 'toStateId' })
  toState: WorkflowState;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({
    type: 'enum',
    enum: TransitionType,
    default: TransitionType.MANUAL,
  })
  type: TransitionType;

  @Column({ type: 'jsonb', default: {} })
  conditions: {
    operator: 'AND' | 'OR';
    rules: Array<{
      field: string;
      operator: string; // 'equals', 'not_equals', 'greater_than', 'less_than', 'contains', 'in'
      value: any;
    }>;
  };

  @Column({ type: 'jsonb', default: {} })
  actions: Array<{
    type: string; // 'notification', 'webhook', 'task', 'email', 'update_field'
    config: Record<string, any>;
  }>;

  @Column({ type: 'jsonb', default: {} })
  permissions: {
    roles: string[];
    users: string[];
    requireApproval: boolean;
    approvers: string[];
  };

  @Column({ default: true })
  isActive: boolean;
}
