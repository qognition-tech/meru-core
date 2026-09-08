import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { JobStatus, JobPriority, JobType } from '../interfaces/job.interface';
import type {
  JobData,
  JobResult,
  JobProgress,
} from '../interfaces/job.interface';

@Entity('queue_jobs')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'type'])
@Index(['status'])
@Index(['scheduledFor'])
@Index(['priority', 'createdAt'])
export class QueueJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({
    type: 'enum',
    enum: JobType,
  })
  type: JobType;

  @Column({
    type: 'enum',
    enum: JobStatus,
    default: JobStatus.PENDING,
  })
  status: JobStatus;

  @Column({
    type: 'enum',
    enum: JobPriority,
    default: JobPriority.NORMAL,
  })
  priority: JobPriority;

  @Column({ type: 'jsonb' })
  data: JobData;

  @Column({ type: 'jsonb', nullable: true })
  result: JobResult | null;

  @Column({ type: 'jsonb', nullable: true })
  progress: JobProgress | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'int', default: 3 })
  maxAttempts: number;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  scheduledFor: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  failedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  processedBy: string | null; // Worker ID

  @Column({ type: 'int', default: 0 })
  duration: number; // Processing duration in milliseconds

  @Column({ type: 'simple-array', default: '' })
  tags: string[];

  @Column({ type: 'jsonb', default: {} })
  options: {
    timeout?: number;
    backoff?: {
      type: 'fixed' | 'exponential';
      delay: number;
    };
    removeOnComplete?: boolean;
    removeOnFail?: boolean;
  };

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

@Entity('queue_job_logs')
@Index(['jobId'])
@Index(['createdAt'])
export class QueueJobLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  jobId: string;

  @Column({
    type: 'enum',
    enum: ['started', 'progress', 'completed', 'failed', 'retry'],
  })
  event: 'started' | 'progress' | 'completed' | 'failed' | 'retry';

  @Column({ type: 'jsonb', nullable: true })
  details: Record<string, any> | null;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('queue_workers')
@Index(['status'])
export class QueueWorker {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({
    type: 'enum',
    enum: ['active', 'paused', 'stopped'],
    default: 'active',
  })
  status: 'active' | 'paused' | 'stopped';

  @Column({ type: 'simple-array' })
  jobTypes: string[];

  @Column({ type: 'int' })
  concurrency: number;

  @Column({ type: 'jsonb', default: {} })
  currentJobs: {
    jobId: string;
    startedAt: Date;
    type: string;
  }[];

  @Column({ type: 'timestamptz', nullable: true })
  lastHeartbeat: Date | null;

  @Column({ type: 'jsonb', default: {} })
  stats: {
    totalProcessed: number;
    totalFailed: number;
    avgProcessingTime: number;
  };

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

@Entity('queue_scheduled_jobs')
@Index(['tenantId'])
@Index(['type'])
@Index(['nextRun'])
export class QueueScheduledJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column()
  name: string;

  @Column({
    type: 'enum',
    enum: JobType,
  })
  type: JobType;

  @Column({ type: 'jsonb' })
  data: JobData;

  @Column()
  cronExpression: string;

  @Column({ type: 'timestamptz' })
  nextRun: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastRun: Date | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'int', default: 0 })
  runCount: number;

  @Column({ type: 'int', nullable: true })
  maxRuns: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  endDate: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
