import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, In, DataSource } from 'typeorm';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  QueueJob,
  QueueJobLog,
  QueueScheduledJob,
  QueueWorker,
} from './entities/job.entity';
import {
  JobStatus,
  JobPriority,
  JobType,
  JobData,
  JobOptions,
  JobResult,
  JobProgress,
  JobFilter,
  QueueMetrics,
} from './interfaces/job.interface';
import { v4 as uuidv4 } from 'uuid';
import { CronExpressionParser } from 'cron-parser';

@Injectable()
export class QueueService implements OnModuleInit {
  private readonly logger = new Logger(QueueService.name);
  private workers: Map<string, QueueWorker> = new Map();

  constructor(
    @InjectRepository(QueueJob)
    private jobRepo: Repository<QueueJob>,
    @InjectRepository(QueueJobLog)
    private logRepo: Repository<QueueJobLog>,
    @InjectRepository(QueueScheduledJob)
    public scheduledRepo: Repository<QueueScheduledJob>,
    @InjectRepository(QueueWorker)
    private workerRepo: Repository<QueueWorker>,
    private dataSource: DataSource,
    private eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    // Resume any pending jobs on startup
    await this.resumePendingJobs();
    // Start scheduled job processor
    this.startScheduledJobProcessor();
  }

  // ==================== JOB CREATION ====================

  async createJob(
    tenantId: string,
    type: JobType,
    data: JobData,
    options: JobOptions = {},
    userId?: string,
  ): Promise<QueueJob> {
    const job = this.jobRepo.create({
      tenantId,
      type,
      status: options.delay ? JobStatus.SCHEDULED : JobStatus.PENDING,
      priority: options.priority || JobPriority.NORMAL,
      data: {
        ...data,
        tenantId,
        userId,
      },
      maxAttempts: options.attempts || 3,
      scheduledFor: options.delay ? new Date(Date.now() + options.delay) : null,
      tags: data.metadata?.tags || [],
      options: {
        timeout: options.timeout,
        backoff: options.backoff,
        removeOnComplete: options.removeOnComplete,
        removeOnFail: options.removeOnFail,
      },
    } as any);

    const saved = (await this.jobRepo.save(job)) as unknown as QueueJob;

    this.logger.log(
      `Job created: ${saved.id} (${type}) for tenant ${tenantId}`,
    );

    // Emit event for immediate processing
    if (!options.delay) {
      this.eventEmitter.emit('queue.job.created', saved);
    }

    return saved;
  }

  async createBulkJobs(
    tenantId: string,
    jobs: { type: JobType; data: JobData; options?: JobOptions }[],
    userId?: string,
  ): Promise<QueueJob[]> {
    const created: QueueJob[] = [];

    for (const jobData of jobs) {
      try {
        const job = await this.createJob(
          tenantId,
          jobData.type,
          jobData.data,
          jobData.options,
          userId,
        );
        created.push(job);
      } catch (error) {
        this.logger.error(`Failed to create job: ${error.message}`);
      }
    }

    return created;
  }

  // ==================== SCHEDULED JOBS ====================

  async scheduleJob(
    tenantId: string,
    name: string,
    type: JobType,
    data: JobData,
    cronExpression: string,
    options?: { endDate?: Date; maxRuns?: number },
  ): Promise<QueueScheduledJob> {
    // Validate cron expression
    try {
      CronExpressionParser.parse(cronExpression);
    } catch (error) {
      throw new Error(`Invalid cron expression: ${cronExpression}`);
    }

    const interval = CronExpressionParser.parse(cronExpression);
    const nextRun = interval.next().toDate();

    const scheduled = this.scheduledRepo.create({
      id: uuidv4(),
      tenantId,
      name,
      type,
      data,
      cronExpression,
      nextRun,
      endDate: options?.endDate || null,
      maxRuns: options?.maxRuns || null,
    });

    return this.scheduledRepo.save(scheduled);
  }

  async cancelScheduledJob(id: string, tenantId: string): Promise<void> {
    const scheduled = await this.scheduledRepo.findOne({
      where: { id, tenantId },
    });
    if (!scheduled) {
      throw new NotFoundException('Scheduled job not found');
    }

    scheduled.isActive = false;
    await this.scheduledRepo.save(scheduled);
  }

  // ==================== JOB PROCESSING ====================

  async getNextJob(
    workerTypes: JobType[],
    tenantId?: string,
  ): Promise<QueueJob | null> {
    const queryBuilder = this.jobRepo.createQueryBuilder('job');

    queryBuilder.where('job.status = :status', { status: JobStatus.PENDING });

    if (tenantId) {
      queryBuilder.andWhere('job.tenantId = :tenantId', { tenantId });
    }

    queryBuilder.andWhere('job.type IN (:...types)', { types: workerTypes });
    queryBuilder.andWhere(
      '(job.scheduledFor IS NULL OR job.scheduledFor <= :now)',
      { now: new Date() },
    );

    queryBuilder.orderBy('job.priority', 'ASC');
    queryBuilder.addOrderBy('job.createdAt', 'ASC');

    queryBuilder.setLock('pessimistic_write');

    const job = await queryBuilder.getOne();

    if (job) {
      // Mark as processing
      job.status = JobStatus.PROCESSING;
      job.processedAt = new Date();
      job.attempts += 1;
      await this.jobRepo.save(job);

      // Log start
      await this.logJobEvent(job.id, 'started', { attempt: job.attempts });

      this.logger.log(`Job processing: ${job.id} (${job.type})`);
    }

    return job;
  }

  async updateProgress(jobId: string, progress: JobProgress): Promise<void> {
    await this.jobRepo.update(jobId, { progress });

    await this.logJobEvent(jobId, 'progress', {
      percentage: progress.percentage,
      message: progress.message,
    });

    // Emit progress event
    this.eventEmitter.emit('queue.job.progress', { jobId, progress });
  }

  async completeJob(jobId: string, result: JobResult): Promise<void> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) return;

    job.status = JobStatus.COMPLETED;
    job.completedAt = new Date();
    job.result = result;
    job.duration = Date.now() - job.processedAt!.getTime();

    await this.jobRepo.save(job);

    await this.logJobEvent(jobId, 'completed', {
      duration: job.duration,
      data: result.data,
    });

    this.eventEmitter.emit('queue.job.completed', job);

    // Remove if configured
    if (job.options.removeOnComplete) {
      await this.removeJob(jobId);
    }

    this.logger.log(`Job completed: ${jobId} in ${job.duration}ms`);
  }

  async failJob(
    jobId: string,
    error: string,
    shouldRetry: boolean = false,
  ): Promise<void> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) return;

    job.lastError = error;
    job.failedAt = new Date();

    if (shouldRetry && job.attempts < job.maxAttempts) {
      job.status = JobStatus.RETRYING;

      // Calculate retry delay
      let retryDelay = 5000; // Default 5 seconds
      if (job.options.backoff) {
        if (job.options.backoff.type === 'exponential') {
          retryDelay =
            job.options.backoff.delay * Math.pow(2, job.attempts - 1);
        } else {
          retryDelay = job.options.backoff.delay;
        }
      }

      job.scheduledFor = new Date(Date.now() + retryDelay);

      await this.logJobEvent(jobId, 'retry', {
        attempt: job.attempts,
        error,
        retryDelay,
      });
      this.logger.log(
        `Job retrying: ${jobId} (attempt ${job.attempts}/${job.maxAttempts})`,
      );
    } else {
      job.status = JobStatus.FAILED;
      job.duration = Date.now() - (job.processedAt?.getTime() || Date.now());
      job.result = { success: false, error };

      await this.logJobEvent(jobId, 'failed', {
        error,
        attempts: job.attempts,
      });
      this.eventEmitter.emit('queue.job.failed', job);

      this.logger.error(`Job failed: ${jobId} - ${error}`);
    }

    await this.jobRepo.save(job);
  }

  // ==================== JOB MANAGEMENT ====================

  async getJobs(
    filter: JobFilter,
    page: number = 1,
    limit: number = 20,
  ): Promise<{ jobs: QueueJob[]; total: number }> {
    const queryBuilder = this.jobRepo.createQueryBuilder('job');

    if (filter.tenantId) {
      queryBuilder.where('job.tenantId = :tenantId', {
        tenantId: filter.tenantId,
      });
    }

    if (filter.status) {
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
      queryBuilder.andWhere('job.status IN (:...statuses)', { statuses });
    }

    if (filter.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      queryBuilder.andWhere('job.type IN (:...types)', { types });
    }

    if (filter.userId) {
      queryBuilder.andWhere("job.data->>'userId' = :userId", {
        userId: filter.userId,
      });
    }

    if (filter.priority) {
      queryBuilder.andWhere('job.priority = :priority', {
        priority: filter.priority,
      });
    }

    if (filter.createdAfter) {
      queryBuilder.andWhere('job.createdAt >= :createdAfter', {
        createdAfter: filter.createdAfter,
      });
    }

    if (filter.createdBefore) {
      queryBuilder.andWhere('job.createdAt <= :createdBefore', {
        createdBefore: filter.createdBefore,
      });
    }

    if (filter.tags?.length) {
      queryBuilder.andWhere('job.tags && :tags', { tags: filter.tags });
    }

    queryBuilder.orderBy('job.createdAt', 'DESC');
    queryBuilder.skip((page - 1) * limit).take(limit);

    const [jobs, total] = await queryBuilder.getManyAndCount();

    return { jobs, total };
  }

  async getJob(jobId: string, tenantId?: string): Promise<QueueJob> {
    const where: any = { id: jobId };
    if (tenantId) where.tenantId = tenantId;

    const job = await this.jobRepo.findOne({ where });
    if (!job) {
      throw new NotFoundException('Job not found');
    }

    return job;
  }

  async getJobLogs(jobId: string): Promise<QueueJobLog[]> {
    return this.logRepo.find({
      where: { jobId },
      order: { createdAt: 'ASC' },
    });
  }

  async retryJob(
    jobId: string,
    tenantId?: string,
    delay?: number,
  ): Promise<QueueJob> {
    const job = await this.getJob(jobId, tenantId);

    if (job.status !== JobStatus.FAILED && job.status !== JobStatus.CANCELLED) {
      throw new Error('Only failed or cancelled jobs can be retried');
    }

    job.status = JobStatus.PENDING;
    job.attempts = 0;
    job.lastError = null;
    job.failedAt = null;
    job.completedAt = null;
    job.result = null;
    job.progress = null;
    job.scheduledFor = delay ? new Date(Date.now() + delay) : null;

    return this.jobRepo.save(job);
  }

  async cancelJob(jobId: string, tenantId?: string): Promise<void> {
    const job = await this.getJob(jobId, tenantId);

    if (job.status === JobStatus.COMPLETED || job.status === JobStatus.FAILED) {
      throw new Error('Cannot cancel completed or failed jobs');
    }

    job.status = JobStatus.CANCELLED;
    await this.jobRepo.save(job);

    this.logger.log(`Job cancelled: ${jobId}`);
  }

  async removeJob(jobId: string): Promise<void> {
    await this.logRepo.delete({ jobId });
    await this.jobRepo.delete(jobId);
  }

  // ==================== METRICS ====================

  async getMetrics(tenantId?: string): Promise<QueueMetrics> {
    const where = tenantId ? { tenantId } : {};

    const [active, waiting, completed, failed, delayed] = await Promise.all([
      this.jobRepo.count({ where: { ...where, status: JobStatus.PROCESSING } }),
      this.jobRepo.count({ where: { ...where, status: JobStatus.PENDING } }),
      this.jobRepo.count({ where: { ...where, status: JobStatus.COMPLETED } }),
      this.jobRepo.count({ where: { ...where, status: JobStatus.FAILED } }),
      this.jobRepo.count({
        where: {
          ...where,
          status: JobStatus.SCHEDULED,
          scheduledFor: LessThan(new Date()),
        },
      }),
    ]);

    // Get stats by type
    const typeStats = await this.jobRepo
      .createQueryBuilder('job')
      .select('job.type', 'type')
      .addSelect(
        'COUNT(CASE WHEN job.status = :processing THEN 1 END)',
        'active',
      )
      .addSelect(
        'COUNT(CASE WHEN job.status = :completed THEN 1 END)',
        'completed',
      )
      .addSelect('COUNT(CASE WHEN job.status = :failed THEN 1 END)', 'failed')
      .addSelect(
        'AVG(CASE WHEN job.status = :completed THEN job.duration END)',
        'avgDuration',
      )
      .where(tenantId ? 'job.tenantId = :tenantId' : '1=1', { tenantId })
      .setParameters({
        processing: JobStatus.PROCESSING,
        completed: JobStatus.COMPLETED,
        failed: JobStatus.FAILED,
      })
      .groupBy('job.type')
      .getRawMany();

    const byType: Record<string, any> = {};
    for (const stat of typeStats) {
      byType[stat.type] = {
        active: parseInt(stat.active) || 0,
        completed: parseInt(stat.completed) || 0,
        failed: parseInt(stat.failed) || 0,
        avgDuration: parseFloat(stat.avgDuration) || 0,
      };
    }

    return {
      active,
      waiting,
      completed,
      failed,
      delayed,
      paused: 0, // Not implemented yet
      byType,
    };
  }

  // ==================== PRIVATE HELPERS ====================

  private async resumePendingJobs(): Promise<void> {
    // Reset any jobs stuck in processing (e.g., after crash)
    const stuckJobs = await this.jobRepo.find({
      where: { status: JobStatus.PROCESSING },
    });

    for (const job of stuckJobs) {
      job.status = JobStatus.PENDING;
      job.processedAt = null;
      await this.jobRepo.save(job);
      this.logger.log(`Reset stuck job: ${job.id}`);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  private async startScheduledJobProcessor(): Promise<void> {
    const scheduledJobs = await this.scheduledRepo.find({
      where: {
        isActive: true,
        nextRun: LessThan(new Date()),
      },
    });

    for (const scheduled of scheduledJobs) {
      try {
        // Create job
        await this.createJob(
          scheduled.tenantId,
          scheduled.type,
          scheduled.data,
        );

        // Update scheduled job
        scheduled.lastRun = new Date();
        scheduled.runCount += 1;

        // Calculate next run
        const interval = CronExpressionParser.parse(scheduled.cronExpression);
        scheduled.nextRun = interval.next().toDate();

        // Check if should stop
        if (scheduled.maxRuns && scheduled.runCount >= scheduled.maxRuns) {
          scheduled.isActive = false;
        }
        if (scheduled.endDate && new Date() > scheduled.endDate) {
          scheduled.isActive = false;
        }

        await this.scheduledRepo.save(scheduled);
      } catch (error) {
        this.logger.error(
          `Failed to process scheduled job ${scheduled.id}: ${error.message}`,
        );
      }
    }
  }

  private async logJobEvent(
    jobId: string,
    event: 'started' | 'progress' | 'completed' | 'failed' | 'retry',
    details?: Record<string, any>,
  ): Promise<void> {
    const log = this.logRepo.create({
      jobId,
      event,
      details,
    });
    await this.logRepo.save(log);
  }
}
