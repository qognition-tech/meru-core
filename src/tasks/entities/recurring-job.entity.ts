import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum RecurringJobStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  ERROR = 'error',
}

@Entity('recurring_jobs')
@Index(['tenantId', 'status'])
export class RecurringJob {
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
  schedule: string; // Cron expression or 'daily', 'weekly', 'monthly'

  @Column({ type: 'jsonb' })
  taskTemplate: {
    title: string;
    description: string;
    type: string;
    priority: string;
    assignedTo: string;
    config: Record<string, any>;
  };

  @Column({
    type: 'enum',
    enum: RecurringJobStatus,
    default: RecurringJobStatus.ACTIVE,
  })
  status: RecurringJobStatus;

  @Column({ type: 'timestamp', nullable: true })
  lastRunAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  nextRunAt: Date;

  @Column({ type: 'int', default: 0 })
  runCount: number;

  @Column({ type: 'timestamp', nullable: true })
  startDate: Date;

  @Column({ type: 'timestamp', nullable: true })
  endDate: Date;

  @Column({ type: 'jsonb', default: [] })
  runHistory: Array<{
    timestamp: Date;
    status: 'success' | 'error';
    taskId?: string;
    error?: string;
  }>;

  @Column({ type: 'jsonb', default: {} })
  config: {
    timezone?: string;
    skipWeekends?: boolean;
    skipHolidays?: boolean;
    maxRuns?: number;
    retryOnError?: boolean;
  };

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
