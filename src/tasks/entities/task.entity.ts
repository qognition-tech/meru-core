import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { TaskComment } from './task-comment.entity';

export enum TaskStatus {
  TODO = 'todo',
  IN_PROGRESS = 'in_progress',
  UNDER_REVIEW = 'under_review',
  DONE = 'done',
  CANCELLED = 'cancelled',
  BLOCKED = 'blocked',
}

export enum TaskPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  URGENT = 'urgent',
}

export enum TaskType {
  APPROVAL = 'approval',
  REVIEW = 'review',
  ACTION = 'action',
  NOTIFICATION = 'notification',
  REMINDER = 'reminder',
  WORKFLOW = 'workflow',
  RECURRING = 'recurring',
}

@Entity('tasks')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'assignedTo'])
@Index(['tenantId', 'dueDate'])
@Index(['entityId', 'entityType'])
export class Task {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column()
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'enum', enum: TaskType, default: TaskType.ACTION })
  type: TaskType;

  @Column({ type: 'enum', enum: TaskStatus, default: TaskStatus.TODO })
  status: TaskStatus;

  @Column({ type: 'enum', enum: TaskPriority, default: TaskPriority.MEDIUM })
  priority: TaskPriority;

  @Column()
  assignedTo: string;

  @Column({ nullable: true })
  assignedBy: string;

  @Column({ type: 'timestamp', nullable: true })
  dueDate: Date;

  @Column({ type: 'timestamp', nullable: true })
  reminderDate: Date;

  @Column({ nullable: true })
  entityId: string;

  @Column({ nullable: true })
  entityType: string;

  @Column({ nullable: true })
  workflowInstanceId: string;

  @Column({ type: 'jsonb', default: {} })
  config: {
    actionRequired?: string;
    actionType?: string;
    actionConfig?: Record<string, any>;
    autoComplete?: boolean;
    completeOnAction?: string[];
    notifyOnCreate?: boolean;
    notifyOnComplete?: boolean;
    escalationEnabled?: boolean;
    escalationAfter?: number;
    escalationAssignTo?: string;
  };

  @OneToMany(() => TaskComment, (comment) => comment.task, { cascade: true })
  comments: TaskComment[];

  @Column({ type: 'jsonb', default: [] })
  attachments: Array<{
    id: string;
    name: string;
    type: string;
    url: string;
    uploadedAt: Date;
    uploadedBy: string;
  }>;

  @Column({ type: 'jsonb', default: {} })
  metadata: {
    source?: string;
    formSubmissionId?: string;
    documentId?: string;
    workflowId?: string;
    customData?: Record<string, any>;
  };

  @Column({ type: 'timestamp', nullable: true })
  startedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date;

  @Column({ type: 'uuid', nullable: true })
  completedBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  deletedAt: Date;
}
