import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { Workflow } from './workflow.entity';
import { WorkflowTransition } from './workflow-transition.entity';

export enum StateType {
  START = 'start',
  INTERMEDIATE = 'intermediate',
  END = 'end',
}

@Entity('workflow_states')
@Index(['workflowId', 'name'])
export class WorkflowState {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  workflowId: string;

  @ManyToOne(() => Workflow, (workflow) => workflow.states, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'workflowId' })
  workflow: Workflow;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'enum', enum: StateType, default: StateType.INTERMEDIATE })
  type: StateType;

  @Column({ type: 'jsonb', default: {} })
  config: {
    color?: string;
    icon?: string;
    slaHours?: number;
    autoActions?: Array<{
      type: string;
      config: Record<string, any>;
    }>;
    notifications?: Array<{
      event: 'enter' | 'exit' | 'sla_warning';
      recipients: string[];
      template: string;
    }>;
  };

  @OneToMany(() => WorkflowTransition, (transition) => transition.fromState)
  outgoingTransitions: WorkflowTransition[];

  @OneToMany(() => WorkflowTransition, (transition) => transition.toState)
  incomingTransitions: WorkflowTransition[];
}
