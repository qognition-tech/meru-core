import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, LessThan, MoreThan, MoreThanOrEqual, Repository } from 'typeorm';
import {
  Task,
  TaskStatus,
  TaskType,
  TaskPriority,
} from './entities/task.entity';
import { TaskComment } from './entities/task-comment.entity';
import {
  RecurringJob,
  RecurringJobStatus,
} from './entities/recurring-job.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SearchService } from '../search/search.service';
import { AiService } from '../ai/ai.service';
import { DocumentHubService } from '../documents/document-hub.service';
import { Document } from '../documents/entities/document.entity';

export interface CreateTaskDto {
  title: string;
  description?: string;
  type?: TaskType;
  priority?: TaskPriority;
  assignedTo: string;
  assignedBy: string;
  dueDate?: Date;
  reminderDate?: Date;
  entityId?: string;
  entityType?: string;
  workflowInstanceId?: string;
  config?: Record<string, any>;
  metadata?: Record<string, any>;
}

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(
    @InjectRepository(Task)
    private taskRepo: Repository<Task>,
    @InjectRepository(TaskComment)
    private commentRepo: Repository<TaskComment>,
    @InjectRepository(RecurringJob)
    private recurringJobRepo: Repository<RecurringJob>,
    private searchService: SearchService,
    @Inject(forwardRef(() => AiService))
    private aiService: AiService,
    @Inject(forwardRef(() => DocumentHubService))
    private documentHubService: DocumentHubService,
  ) {}

  // ==================== TASKS ====================

  async createTask(tenantId: string, dto: CreateTaskDto): Promise<Task> {
    const task = this.taskRepo.create({
      tenantId,
      ...dto,
      status: TaskStatus.TODO,
    });

    const saved = await this.taskRepo.save(task);
    this.logger.log(`Task created: ${saved.id}`);

    return this.getTask(saved.id);
  }

  async getTask(id: string): Promise<Task> {
    const task = await this.taskRepo.findOne({
      where: { id },
      relations: ['comments'],
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    return task;
  }

  async listTasks(
    tenantId: string,
    options: {
      status?: TaskStatus;
      assignedTo?: string;
      priority?: TaskPriority;
      type?: TaskType;
      entityId?: string;
      dueBefore?: Date;
      dueAfter?: Date;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<{ items: Task[]; total: number; page: number; limit: number }> {
    const where: Record<string, unknown> = { tenantId };

    if (options.status) where.status = options.status;
    if (options.assignedTo) where.assignedTo = options.assignedTo;
    if (options.priority) where.priority = options.priority;
    if (options.type) where.type = options.type;
    if (options.entityId) where.entityId = options.entityId;

    // Both bounds together used to build `{ ...LessThan(x), $moreThan: y }`.
    // `$moreThan` is not a TypeORM operator — it is Mongo syntax — so the object
    // was a `LessThan` with an inert extra key: the lower bound was silently
    // dropped and the query answered a different question than it was asked.
    // Same class of fault as the calendar range below.
    if (options.dueBefore && options.dueAfter) {
      where.dueDate = Between(options.dueAfter, options.dueBefore);
    } else if (options.dueBefore) {
      where.dueDate = LessThan(options.dueBefore);
    } else if (options.dueAfter) {
      where.dueDate = MoreThanOrEqual(options.dueAfter);
    }

    const page = Math.max(1, Number(options.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));

    const [items, total] = await this.taskRepo.findAndCount({
      where,
      relations: ['comments'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { items, total, page, limit };
  }

  async updateTask(
    id: string,
    tenantId: string,
    updates: Partial<Task>,
  ): Promise<Task> {
    const task = await this.taskRepo.findOne({
      where: { id, tenantId },
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    Object.assign(task, updates);
    await this.taskRepo.save(task);

    return this.getTask(id);
  }

  async startTask(id: string, tenantId: string, userId: string): Promise<Task> {
    return this.updateTask(id, tenantId, {
      status: TaskStatus.IN_PROGRESS,
      startedAt: new Date(),
    });
  }

  async completeTask(
    id: string,
    tenantId: string,
    userId: string,
  ): Promise<Task> {
    return this.updateTask(id, tenantId, {
      status: TaskStatus.DONE,
      completedAt: new Date(),
      completedBy: userId,
    });
  }

  async cancelTask(
    id: string,
    tenantId: string,
    reason?: string,
  ): Promise<Task> {
    return this.updateTask(id, tenantId, {
      status: TaskStatus.CANCELLED,
    });
  }

  // ==================== MY WORK (UNIFIED INBOX) ====================

  async getMyWork(
    tenantId: string,
    userId: string,
    options: {
      status?: TaskStatus[];
      includeCompleted?: boolean;
      limit?: number;
    } = {},
  ): Promise<{
    tasks: Task[];
    counts: Record<string, number>;
  }> {
    const where: any = {
      tenantId,
      assignedTo: userId,
    };

    // `In(...)`, not a bare array. A plain array in TypeORM find-options is not
    // an IN clause — it is serialised as a Postgres array literal and compared
    // against the column, so this 500'd with
    //   invalid input value for enum tasks_status_enum: "{"todo","in_progress",…}"
    // and /tasks/my-work was unreachable. Same family as the `revokedAt: null`
    // bug in IamService: find-options syntax that looks right and silently
    // means something else.
    if (options.status?.length) {
      where.status = In(options.status);
    } else if (!options.includeCompleted) {
      where.status = In([
        TaskStatus.TODO,
        TaskStatus.IN_PROGRESS,
        TaskStatus.UNDER_REVIEW,
        TaskStatus.BLOCKED,
      ]);
    }

    const tasks = await this.taskRepo.find({
      where,
      relations: ['comments'],
      order: { priority: 'DESC', dueDate: 'ASC' },
      take: options.limit || 50,
    });

    // Get counts for each status
    const counts = await this.getTaskCounts(tenantId, userId);

    return { tasks, counts };
  }

  /**
   * Per-status task counts for one assignee.
   *
   * Statuses come from the enum rather than a hand-written list. The list had
   * drifted: it contained `completed`, which is not a TaskStatus — the member
   * is `done` — and `status as TaskStatus` silenced the type error, so the
   * count query reached Postgres and 500'd with
   * `invalid input value for enum tasks_status_enum: "completed"`, taking all
   * of `/tasks/my-work` down with it.
   *
   * One grouped query rather than a COUNT per status: the old loop issued a
   * round trip for every state and then summed a `total` that included itself
   * had the key ordering differed.
   */
  private async getTaskCounts(
    tenantId: string,
    userId: string,
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = Object.fromEntries(
      Object.values(TaskStatus).map((s) => [s, 0]),
    );

    const rows = await this.taskRepo
      .createQueryBuilder('t')
      .select('t.status', 'status')
      .addSelect('COUNT(*)::int', 'count')
      .where('t."tenantId" = :tenantId', { tenantId })
      .andWhere('t."assignedTo" = :userId', { userId })
      .groupBy('t.status')
      .getRawMany<{ status: string; count: number }>();

    for (const row of rows) counts[row.status] = row.count;

    counts.total = rows.reduce((sum, r) => sum + r.count, 0);

    return counts;
  }

  // ==================== TASK COMMENTS ====================

  async addComment(
    taskId: string,
    tenantId: string,
    userId: string,
    content: string,
  ): Promise<TaskComment> {
    const task = await this.taskRepo.findOne({
      where: { id: taskId, tenantId },
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const comment = this.commentRepo.create({
      taskId,
      userId,
      content,
      mentions: this.extractMentions(content),
    });

    return this.commentRepo.save(comment);
  }

  private extractMentions(content: string): string[] {
    const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
    const matches = content.match(mentionRegex);
    return matches ? matches.map((m) => m.substring(1)) : [];
  }

  // ==================== RECURRING JOBS ====================

  async createRecurringJob(
    tenantId: string,
    dto: {
      name: string;
      description?: string;
      schedule: string;
      taskTemplate: {
        title: string;
        description: string;
        type: string;
        priority: string;
        assignedTo: string;
        config: Record<string, any>;
      };
      startDate?: Date;
      endDate?: Date;
      config?: Record<string, any>;
    },
  ): Promise<RecurringJob> {
    const nextRunAt = this.calculateNextRun(dto.schedule, dto.startDate);

    const job = this.recurringJobRepo.create({
      tenantId,
      name: dto.name,
      description: dto.description,
      schedule: dto.schedule,
      taskTemplate: dto.taskTemplate,
      startDate: dto.startDate,
      endDate: dto.endDate,
      nextRunAt,
      status: RecurringJobStatus.ACTIVE,
      config: dto.config || {},
    });

    const saved = await this.recurringJobRepo.save(job);
    this.logger.log(`Recurring job created: ${saved.id}`);

    return saved;
  }

  async listRecurringJobs(
    tenantId: string,
    status?: RecurringJobStatus,
  ): Promise<RecurringJob[]> {
    const where: any = { tenantId };
    if (status) where.status = status;

    return this.recurringJobRepo.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  async pauseRecurringJob(id: string, tenantId: string): Promise<RecurringJob> {
    const job = await this.recurringJobRepo.findOne({
      where: { id, tenantId },
    });

    if (!job) {
      throw new NotFoundException('Job not found');
    }

    job.status = RecurringJobStatus.PAUSED;
    return this.recurringJobRepo.save(job);
  }

  async resumeRecurringJob(
    id: string,
    tenantId: string,
  ): Promise<RecurringJob> {
    const job = await this.recurringJobRepo.findOne({
      where: { id, tenantId },
    });

    if (!job) {
      throw new NotFoundException('Job not found');
    }

    job.status = RecurringJobStatus.ACTIVE;
    job.nextRunAt = this.calculateNextRun(job.schedule);
    return this.recurringJobRepo.save(job);
  }

  // ==================== SCHEDULED JOBS ====================

  @Cron(CronExpression.EVERY_MINUTE)
  async processRecurringJobs() {
    const now = new Date();

    const jobs = await this.recurringJobRepo.find({
      where: {
        status: RecurringJobStatus.ACTIVE,
        nextRunAt: LessThan(now),
      },
    });

    this.logger.log(`Processing ${jobs.length} recurring jobs`);

    for (const job of jobs) {
      try {
        await this.executeRecurringJob(job);
      } catch (error) {
        this.logger.error(`Failed to execute job ${job.id}:`, error);

        job.runHistory.push({
          timestamp: new Date(),
          status: 'error',
          error: error.message,
        });

        if (job.config.retryOnError) {
          job.status = RecurringJobStatus.ERROR;
        }

        await this.recurringJobRepo.save(job);
      }
    }
  }

  private async executeRecurringJob(job: RecurringJob): Promise<void> {
    // Check if max runs reached
    if (job.config.maxRuns && job.runCount >= job.config.maxRuns) {
      job.status = RecurringJobStatus.COMPLETED;
      await this.recurringJobRepo.save(job);
      return;
    }

    // Create task from template
    const task = await this.createTask(job.tenantId, {
      title: job.taskTemplate.title,
      description: job.taskTemplate.description,
      type: job.taskTemplate.type as TaskType,
      priority: job.taskTemplate.priority as TaskPriority,
      assignedTo: job.taskTemplate.assignedTo,
      assignedBy: 'system', // Recurring jobs are created by system
      config: job.taskTemplate.config,
    });

    // Update job
    job.runCount++;
    job.lastRunAt = new Date();
    job.nextRunAt = this.calculateNextRun(job.schedule);
    job.runHistory.push({
      timestamp: new Date(),
      status: 'success',
      taskId: task.id,
    });

    await this.recurringJobRepo.save(job);

    this.logger.log(
      `Recurring job ${job.id} executed, task ${task.id} created`,
    );
  }

  private calculateNextRun(schedule: string, startDate?: Date): Date {
    const now = new Date();
    const base = startDate && startDate > now ? startDate : now;

    switch (schedule) {
      case 'daily':
        return new Date(base.getTime() + 24 * 60 * 60 * 1000);
      case 'weekly':
        return new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000);
      case 'monthly':
        const nextMonth = new Date(base);
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        return nextMonth;
      default:
        // Assume it's a cron expression - parse it (simplified)
        // In production, use a proper cron parser
        return new Date(base.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  // ==================== CALENDAR INTEGRATION ====================

  /**
   * Tasks with a due date inside a window, as calendar events.
   *
   * The range filter was `MoreThan(start) && LessThan(end)`. `&&` evaluates to
   * its right operand, so the expression *is* `LessThan(end)` and `startDate`
   * was discarded — the endpoint silently answered "everything due before the
   * end of the window", including last year's. It reads like a range and is not
   * one, which is why it survived review. `Between` says what was meant.
   *
   * `scope: 'firm'` returns every task in the tenant. The endpoint was
   * hard-scoped to the caller with no way to widen it, so a shared team calendar
   * — the main thing a firm wants a calendar for — could not be built from it,
   * and the frontend assembled its month grid client-side instead.
   */
  async getCalendarEvents(
    tenantId: string,
    userId: string,
    startDate: Date,
    endDate: Date,
    scope: 'mine' | 'firm' = 'mine',
  ): Promise<any[]> {
    const tasks = await this.taskRepo.find({
      where: {
        tenantId,
        ...(scope === 'firm' ? {} : { assignedTo: userId }),
        dueDate: Between(startDate, endDate),
      },
      order: { dueDate: 'ASC' },
    });

    // Convert to calendar events
    return tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      start: task.dueDate,
      end: task.dueDate, // Tasks are typically all-day or have same start/end
      type: 'task',
      status: task.status,
      priority: task.priority,
    }));
  }

  async syncWithExternalCalendar(
    tenantId: string,
    userId: string,
    provider: 'google' | 'outlook',
  ): Promise<{ success: boolean; message: string }> {
    // Placeholder for calendar sync
    // In production, this would use Google Calendar API or Microsoft Graph API
    this.logger.log(`Calendar sync requested: ${provider} for user ${userId}`);

    return {
      success: false,
      message: `Calendar sync with ${provider} is not yet implemented`,
    };
  }

  // ==================== SEARCH & AI INTEGRATION ====================

  async indexTask(task: Task): Promise<void> {
    try {
      const searchableData = {
        tenantId: task.tenantId,
        searchableType: 'task',
        searchableId: task.id,
        title: task.title,
        content: task.description || '',
        metadata: {
          type: task.type,
          status: task.status,
          priority: task.priority,
          assignedTo: task.assignedTo,
          dueDate: task.dueDate,
          entityId: task.entityId,
          entityType: task.entityType,
          workflowInstanceId: task.workflowInstanceId,
        },
      };

      await this.searchService.indexEntityData(searchableData);
      this.logger.debug(`Task indexed: ${task.id}`);
    } catch (error) {
      this.logger.error(`Failed to index task: ${task.id}`, error);
    }
  }

  async searchTasks(
    tenantId: string,
    query: string,
    limit: number = 20,
  ): Promise<any[]> {
    return this.searchService.search(tenantId, query, limit);
  }

  async getPrioritizedTasks(
    tenantId: string,
    userId: string,
  ): Promise<{ tasks: Task[]; aiRecommendations: any }> {
    try {
      // Get all pending tasks for user
      const tasks = await this.taskRepo.find({
        where: {
          tenantId,
          assignedTo: userId,
          status: In([
            TaskStatus.TODO,
            TaskStatus.IN_PROGRESS,
            TaskStatus.BLOCKED,
          ]),
        },
        order: { priority: 'DESC', dueDate: 'ASC' },
      });

      // Get AI recommendations for task prioritization
      const aiAnalysis = await this.aiService.execute({
        category: 'workflow_decision' as any,
        key: 'task_prioritization',
        input: JSON.stringify({
          tasks: tasks.map((t) => ({
            id: t.id,
            title: t.title,
            priority: t.priority,
            dueDate: t.dueDate,
            type: t.type,
            status: t.status,
          })),
        }),
        context: { tenantId, userId },
      });

      return {
        tasks,
        aiRecommendations: JSON.parse(aiAnalysis.result),
      };
    } catch (error) {
      this.logger.error(`Failed to get prioritized tasks: ${error.message}`);

      // Return tasks without AI recommendations on error
      const tasks = await this.taskRepo.find({
        where: {
          tenantId,
          assignedTo: userId,
          status: In([TaskStatus.TODO, TaskStatus.IN_PROGRESS]),
        },
        order: { priority: 'DESC', dueDate: 'ASC' },
      });

      return {
        tasks,
        aiRecommendations: null,
      };
    }
  }

  async suggestTaskFromContext(
    tenantId: string,
    context: {
      entityId?: string;
      entityType?: string;
      workflowInstanceId?: string;
      description: string;
    },
  ): Promise<any> {
    try {
      const suggestion = await this.aiService.execute({
        category: 'workflow_decision' as any,
        key: 'task_suggestion',
        input: JSON.stringify(context),
        context: { tenantId },
      });

      return {
        success: true,
        suggestion: JSON.parse(suggestion.result),
      };
    } catch (error) {
      this.logger.error(`Failed to suggest task: ${error.message}`);
      return {
        success: false,
        suggestion: null,
        error: error.message,
      };
    }
  }

  // ==================== DOCUMENT INTEGRATION ====================

  async getTaskDocuments(
    tenantId: string,
    taskId: string,
  ): Promise<Document[]> {
    return this.documentHubService.getTaskDocuments(tenantId, taskId);
  }

  async attachDocumentToTask(
    tenantId: string,
    taskId: string,
    documentId: string,
    userId: string,
  ): Promise<Document> {
    const task = await this.taskRepo.findOne({
      where: { id: taskId, tenantId },
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    return this.documentHubService.attachDocumentToEntity(
      documentId,
      'task',
      taskId,
      userId,
    );
  }

  async addDocumentAttachment(
    tenantId: string,
    taskId: string,
    documentId: string,
    userId: string,
  ): Promise<Task> {
    const task = await this.taskRepo.findOne({
      where: { id: taskId, tenantId },
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    // Attach document
    await this.attachDocumentToTask(tenantId, taskId, documentId, userId);

    // Get document details
    const document = await this.documentHubService['documentRepo'].findOne({
      where: { id: documentId },
    });

    if (document) {
      // Add to task attachments
      const attachment = {
        id: documentId,
        name: document.name,
        type: document.fileType,
        url: document.s3Url,
        uploadedAt: new Date(),
        uploadedBy: userId,
      };

      task.attachments = [...(task.attachments || []), attachment];
      await this.taskRepo.save(task);

      // Index task with document reference
      await this.indexTask(task);
    }

    return task;
  }

  async searchTaskDocuments(
    tenantId: string,
    taskId: string,
    query: string,
  ): Promise<any[]> {
    return this.documentHubService.searchDocuments(tenantId, query, {
      entityType: 'task',
      entityId: taskId,
    });
  }

  async getTaskDocumentStats(
    tenantId: string,
    taskId: string,
  ): Promise<{
    totalDocuments: number;
    totalSize: number;
    byType: Record<string, number>;
  }> {
    return this.documentHubService.getEntityDocumentStats(
      tenantId,
      'task',
      taskId,
    );
  }
}
