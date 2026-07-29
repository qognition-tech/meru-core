import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SlaWatchdogService } from '../workflow/services/sla-watchdog.service';
import { BillingService } from '../billing/billing.service';
import { QueueService } from '../queue/queue.service';
import { JobProcessor } from '../queue/queue.processor';
import { TaskService } from '../tasks/task.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { RegulatoryRadarEngine } from '../ai/engines/regulatory-radar.engine';
import { Public } from '../iam/decorators/public.decorator';
import { CronSecretGuard } from './cron-secret.guard';

export interface JobResult {
  job: string;
  status: 'ok';
  durationMs: number;
}

export interface TickResult {
  ran: JobResult[];
  skipped: string[];
  failed: { job: string; message: string }[];
  durationMs: number;
}

/** Every scheduled job, and how many minutes it wants between runs. */
const JOB_CADENCE_MINUTES = {
  'queue-drain': 1,
  'scheduled-jobs': 1,
  'recurring-tasks': 1,
  'scheduled-notifications': 1,
  'sla-watchdog': 5,
  'scheduled-reports': 60,
  'daily-billing': 1440,
  'regulatory-radar': 1440,
  'audit-archive': 1440,
  'digest-emails': 1440,
} as const;

export type JobName = keyof typeof JOB_CADENCE_MINUTES;

const JOB_NAMES = Object.keys(JOB_CADENCE_MINUTES) as JobName[];

/**
 * Cron entrypoints.
 *
 * `@nestjs/schedule` @Cron decorators never fire on the serverless runtime, so
 * all nine scheduled jobs are also reachable over HTTP with
 * `Authorization: Bearer <CRON_SECRET>`.
 *
 * Each job answers to both GET and POST. That matters: Vercel Cron only ever
 * issues GET, and vercel.json used to point GET schedules at POST-only
 * handlers, so both cron jobs 404'd on every single invocation. The two verbs
 * are separate handler methods because stacking `@Get()` and `@Post()` on one
 * method does not work — they write the same metadata key and the last
 * decorator applied silently wins.
 *
 * `/jobs/tick` exists for restricted cron plans (Vercel's Hobby tier allows two
 * schedules, firing once a day, which cannot serve a queue that wants draining
 * every minute). It runs whatever is currently due and is safe to call at any
 * frequency, so a free external scheduler can drive the fast jobs while the
 * Vercel crons act as a daily backstop.
 */
@Controller('jobs')
@ApiTags('jobs')
@Public()
@UseGuards(CronSecretGuard)
@ApiHeader({
  name: 'Authorization',
  description: 'Bearer <CRON_SECRET>',
  required: true,
})
@ApiResponse({ status: 401, description: 'Missing or invalid cron secret' })
export class JobsController {
  private readonly logger = new Logger(JobsController.name);

  /**
   * Last successful run per job, so /tick can tell what is due.
   *
   * Deliberately in-memory: it is a de-duplication hint, not a schedule of
   * record. On serverless each cold start forgets it, and the worst case is a
   * job running earlier than its cadence — every handler here is idempotent
   * (they all query for due work and no-op when there is none).
   */
  private readonly lastRun = new Map<JobName, number>();

  constructor(
    private readonly slaWatchdogService: SlaWatchdogService,
    private readonly billingService: BillingService,
    private readonly queueService: QueueService,
    private readonly jobProcessor: JobProcessor,
    private readonly taskService: TaskService,
    private readonly notificationsService: NotificationsService,
    private readonly analyticsService: AnalyticsService,
    private readonly auditService: AuditService,
    private readonly regulatoryRadar: RegulatoryRadarEngine,
  ) {}

  // ── Consolidated dispatcher ───────────────────────────────────────────────
  // Declared before the :job routes so "tick" is not swallowed as a job name.

  @Get('tick')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run every scheduled job that is currently due',
    description:
      'Cadence-aware dispatcher. Safe to call at any frequency — each job runs ' +
      'only once its own interval has elapsed, so a one-minute pinger will not ' +
      'run daily billing 1,440 times a day. One failing job does not stop the ' +
      'rest; failures are reported per job in the response.',
  })
  @ApiResponse({ status: 200, description: 'Dispatch completed' })
  async tickGet(): Promise<TickResult> {
    return this.tick();
  }

  @Post('tick')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run every scheduled job that is currently due' })
  @ApiResponse({ status: 200, description: 'Dispatch completed' })
  async tickPost(): Promise<TickResult> {
    return this.tick();
  }

  // ── Individual job entrypoints ────────────────────────────────────────────

  @Get(':job')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run a single scheduled job by name',
    description:
      'GET is supported because Vercel Cron issues GET requests only. The job ' +
      'runs synchronously and the response reports its duration.',
  })
  @ApiParam({ name: 'job', enum: JOB_NAMES, description: 'Job name' })
  @ApiResponse({ status: 200, description: 'Job completed successfully' })
  @ApiResponse({ status: 404, description: 'Unknown job name' })
  @ApiResponse({ status: 500, description: 'Job failed' })
  async runJobGet(@Param('job') job: string): Promise<JobResult> {
    return this.runNamed(job);
  }

  @Post(':job')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run a single scheduled job by name' })
  @ApiParam({ name: 'job', enum: JOB_NAMES, description: 'Job name' })
  @ApiResponse({ status: 200, description: 'Job completed successfully' })
  @ApiResponse({ status: 404, description: 'Unknown job name' })
  @ApiResponse({ status: 500, description: 'Job failed' })
  async runJobPost(@Param('job') job: string): Promise<JobResult> {
    return this.runNamed(job);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async tick(): Promise<TickResult> {
    const startedAt = Date.now();
    const ran: JobResult[] = [];
    const skipped: string[] = [];
    const failed: { job: string; message: string }[] = [];

    for (const job of JOB_NAMES) {
      const last = this.lastRun.get(job);
      const cadenceMs = JOB_CADENCE_MINUTES[job] * 60_000;

      if (last !== undefined && Date.now() - last < cadenceMs) {
        skipped.push(job);
        continue;
      }

      try {
        ran.push(await this.run(job, this.handlerFor(job)));
        this.lastRun.set(job, Date.now());
      } catch (error) {
        // A failing job must not abort the rest of the tick.
        const message =
          error instanceof Error ? error.message : String(error ?? 'unknown');
        failed.push({ job, message });
      }
    }

    return { ran, skipped, failed, durationMs: Date.now() - startedAt };
  }

  private async runNamed(job: string): Promise<JobResult> {
    if (!JOB_NAMES.includes(job as JobName)) {
      throw new NotFoundException(
        `Unknown job "${job}". Valid jobs: ${JOB_NAMES.join(', ')}`,
      );
    }

    const result = await this.run(job, this.handlerFor(job as JobName));
    this.lastRun.set(job as JobName, Date.now());
    return result;
  }

  private handlerFor(job: JobName): () => Promise<unknown> {
    switch (job) {
      case 'queue-drain':
        // Serverless replacement for the JobProcessor polling loop, which is
        // disabled under VERCEL. Bounded to 25 jobs / 30s per invocation.
        return () => this.jobProcessor.drainQueue();
      case 'scheduled-jobs':
        return () => this.queueService.processScheduledJobs();
      case 'recurring-tasks':
        return () => this.taskService.processRecurringJobs();
      case 'scheduled-notifications':
        return () => this.notificationsService.processScheduledNotifications();
      case 'sla-watchdog':
        return () => this.slaWatchdogService.checkSLAViolations();
      case 'scheduled-reports':
        return () => this.analyticsService.processScheduledReports();
      case 'daily-billing':
        return () => this.billingService.processDailyBilling();
      case 'regulatory-radar':
        return () => this.regulatoryRadar.scheduledScan();
      case 'audit-archive':
        return () => this.auditService.archiveOldLogs();
      case 'digest-emails':
        return () => this.notificationsService.sendDigestEmails();
    }
  }

  private async run(
    job: string,
    fn: () => Promise<unknown>,
  ): Promise<JobResult> {
    const startedAt = Date.now();
    this.logger.log(`Cron job "${job}" started`);

    try {
      await fn();
      const durationMs = Date.now() - startedAt;
      this.logger.log(`Cron job "${job}" completed in ${durationMs}ms`);
      return { job, status: 'ok', durationMs };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message =
        error instanceof Error ? error.message : String(error ?? 'unknown');
      this.logger.error(
        `Cron job "${job}" failed after ${durationMs}ms: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException({
        job,
        status: 'error',
        durationMs,
        message: `Cron job "${job}" failed: ${message}`,
      });
    }
  }
}
