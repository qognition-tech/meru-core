import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
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
import { JobRunService } from './job-run.service';
import { MigrateService, MigrateTarget } from './migrate.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { WatchlistIngestService } from '../ai/engines/watchlist-ingest.service';
import { ScreeningEngine } from '../ai/engines/screening.engine';
import { RescreeningService } from '../ai/engines/rescreening.service';

export interface JobResult {
  job: string;
  status: 'ok';
  durationMs: number;
}

export interface TickResult {
  scope: TickScope;
  ran: JobResult[];
  /** Not due yet, per the cadence table. */
  skipped: string[];
  /** Due, but the time budget ran out — the next call picks these up. */
  deferred: string[];
  failed: { job: string; message: string }[];
  durationMs: number;
}

/** Every scheduled job, and how many minutes it wants between runs. */
export const JOB_CADENCE_MINUTES = {
  'queue-drain': 1,
  'scheduled-jobs': 1,
  'recurring-tasks': 1,
  'scheduled-notifications': 1,
  // The COM delivery sweep. Without this the notifications module writes
  // rows nobody ever sends — it had no transport at all before.
  'notification-dispatch': 1,
  'sla-watchdog': 5,
  'scheduled-reports': 60,
  'daily-billing': 1440,
  'regulatory-radar': 1440,
  'audit-archive': 1440,
  // Sanctions lists change daily; screening against a stale list is the
  // failure mode that matters, so this runs with the daily sweep.
  'watchlist-ingest': 1440,
  // Daily, and deliberately listed AFTER watchlist-ingest: TICK_SCOPES
  // preserves this order, so the sweep runs against lists ingested moments
  // earlier in the same tick rather than yesterday's.
  'rescreening': 1440,
  'digest-emails': 1440,
} as const;

export type JobName = keyof typeof JOB_CADENCE_MINUTES;

const JOB_NAMES = Object.keys(JOB_CADENCE_MINUTES) as JobName[];

/**
 * Which jobs a /tick call considers.
 *
 * The split is not cosmetic. `regulatory-radar` alone takes ~34s of the 60s
 * function limit, and the cadence map below is per-instance, so a cold lambda
 * believes nothing has run yet. Letting a one-minute pinger dispatch the daily
 * jobs would re-run the expensive ones on every cold start and could exceed
 * maxDuration. Frequent work is therefore driven by an external scheduler
 * hitting scope=fast; the daily work is driven by Vercel Cron once a day.
 */
const TICK_SCOPES = {
  fast: JOB_NAMES.filter((j) => JOB_CADENCE_MINUTES[j] <= 60),
  daily: JOB_NAMES.filter((j) => JOB_CADENCE_MINUTES[j] > 60),
  all: JOB_NAMES,
} as const;

export type TickScope = keyof typeof TICK_SCOPES;

/**
 * Stop dispatching once this much of the invocation is gone, so a slow job
 * cannot push the response past the platform's function timeout. Whatever is
 * left is reported as deferred and picked up by the next call.
 */
const TICK_BUDGET_MS = 45_000;

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
    private readonly migrateService: MigrateService,
    private readonly jobRunService: JobRunService,
    private readonly rescreeningService: RescreeningService,
    private readonly notificationDispatch: NotificationDispatchService,
    private readonly watchlistIngest: WatchlistIngestService,
    private readonly screeningEngine: ScreeningEngine,
  ) {}

  // ── Consolidated dispatcher ───────────────────────────────────────────────
  // Declared before the :job routes for the same reason as tick.

  @Post('migrate/:target')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run bundled migrations against one of the three databases',
    description:
      "Machine endpoint (CRON_SECRET). target: 'control' (DATABASE_URL), " +
      "'govx' (GOVX_DB_URL) or 'immistack' (IMMISTACK_DB_URL). Idempotent — " +
      'reports alreadyApplied when the chain is current. Exists because the ' +
      'vertical databases are migrated from deploy infrastructure, not from ' +
      'developer machines (three-DB split, MASTER_GAP_ANALYSIS P1).',
  })
  @ApiResponse({ status: 200, description: 'Migrations executed (or current)' })
  async migrate(@Param('target') target: string) {
    if (!['control', 'govx', 'immistack'].includes(target)) {
      throw new BadRequestException(
        "target must be 'control', 'govx' or 'immistack'",
      );
    }
    return this.migrateService.migrate(target as MigrateTarget);
  }

  // Declared before the :job routes so "tick" is not swallowed as a job name.

  @Get('tick')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run the scheduled jobs in a scope that are currently due',
    description:
      'Cadence-aware dispatcher, safe to call at any frequency — each job runs ' +
      'only once its own interval has elapsed. `scope=fast` (the default) ' +
      'covers the minute-to-hourly jobs and is what an external scheduler ' +
      'should poll; `scope=daily` covers the once-a-day jobs and is what Vercel ' +
      'Cron invokes. Dispatch stops after 45s and reports the remainder as ' +
      'deferred, so a slow job cannot blow the function timeout. One failing ' +
      'job does not stop the rest.',
  })
  @ApiQuery({ name: 'scope', required: false, enum: ['fast', 'daily', 'all'] })
  @ApiResponse({ status: 200, description: 'Dispatch completed' })
  async tickGet(@Query('scope') scope?: string): Promise<TickResult> {
    return this.tick(this.parseScope(scope));
  }

  @Post('tick')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run the scheduled jobs in a scope that are due' })
  @ApiQuery({ name: 'scope', required: false, enum: ['fast', 'daily', 'all'] })
  @ApiResponse({ status: 200, description: 'Dispatch completed' })
  async tickPost(@Query('scope') scope?: string): Promise<TickResult> {
    return this.tick(this.parseScope(scope));
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

  private async tick(scope: TickScope): Promise<TickResult> {
    const startedAt = Date.now();
    const ran: JobResult[] = [];
    const skipped: string[] = [];
    const deferred: string[] = [];
    const failed: { job: string; message: string }[] = [];

    // Durable, so cadence actually holds across instances. The in-memory map
    // is kept as a same-invocation fallback only: if the table cannot be read
    // the tick still runs, it just loses de-duplication, which is safe because
    // every handler is idempotent.
    const persisted = await this.jobRunService.lastRunMap();

    for (const job of TICK_SCOPES[scope]) {
      const last = persisted.get(job) ?? this.lastRun.get(job);
      const cadenceMs = JOB_CADENCE_MINUTES[job] * 60_000;

      if (last !== undefined && Date.now() - last < cadenceMs) {
        skipped.push(job);
        continue;
      }

      if (Date.now() - startedAt > TICK_BUDGET_MS) {
        deferred.push(job);
        continue;
      }

      try {
        const result = await this.run(job, this.handlerFor(job));
        ran.push(result);
        this.lastRun.set(job, Date.now());
        await this.jobRunService.record(job, {
          status: 'ok',
          durationMs: result.durationMs,
        });
      } catch (error) {
        // A failing job must not abort the rest of the tick.
        const message =
          error instanceof Error ? error.message : String(error ?? 'unknown');
        failed.push({ job, message });
        // Recorded too. A job that fails every time would otherwise look
        // identical to one that was never scheduled — both simply absent.
        await this.jobRunService.record(job, {
          status: 'failed',
          durationMs: 0,
          error: message,
        });
      }
    }

    return {
      scope,
      ran,
      skipped,
      deferred,
      failed,
      durationMs: Date.now() - startedAt,
    };
  }

  private parseScope(scope?: string): TickScope {
    if (!scope) return 'fast';
    if (scope in TICK_SCOPES) return scope as TickScope;
    throw new NotFoundException(
      `Unknown scope "${scope}". Valid scopes: ${Object.keys(TICK_SCOPES).join(', ')}`,
    );
  }

  private async runNamed(job: string): Promise<JobResult> {
    if (!JOB_NAMES.includes(job as JobName)) {
      throw new NotFoundException(
        `Unknown job "${job}". Valid jobs: ${JOB_NAMES.join(', ')}`,
      );
    }

    try {
      const result = await this.run(job, this.handlerFor(job as JobName));
      this.lastRun.set(job as JobName, Date.now());
      await this.jobRunService.record(job, {
        status: 'ok',
        durationMs: result.durationMs,
      });
      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? 'unknown');
      await this.jobRunService.record(job, {
        status: 'failed',
        durationMs: 0,
        error: message,
      });
      throw error;
    }
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
      case 'notification-dispatch':
        return async () => {
          await this.notificationDispatch.retryFailed();
          return this.notificationDispatch.dispatchPending();
        };
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
      case 'watchlist-ingest':
        return async () => {
          const result = await this.watchlistIngest.ingestAll();
          // The engine caches lists for 10 minutes; drop it so a fresh
          // ingest takes effect immediately rather than after the TTL.
          this.screeningEngine.invalidateCache();
          return result;
        };
      case 'rescreening':
        // Re-checks names screened before the current list. Returns a
        // `changed` array — a previously-clear name that now hits is the one
        // output of this job somebody must act on.
        return () => this.rescreeningService.sweep();
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
