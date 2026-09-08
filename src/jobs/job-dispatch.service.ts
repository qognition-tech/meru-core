import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SlaWatchdogService } from '../workflow/services/sla-watchdog.service';
import { AlertRuleService } from '../rules/alert-rule.service';
import { SequenceRunnerService } from '../notifications/sequence-runner.service';
import { BillingService } from '../billing/billing.service';
import { QueueService } from '../queue/queue.service';
import { JobProcessor } from '../queue/queue.processor';
import { TaskService } from '../tasks/task.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { RetentionService } from '../audit/retention.service';
import { RegulatoryRadarEngine } from '../ai/engines/regulatory-radar.engine';
import { JobRunService } from './job-run.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { WatchlistIngestService } from '../ai/engines/watchlist-ingest.service';
import { ScreeningEngine } from '../ai/engines/screening.engine';
import { RescreeningService } from '../ai/engines/rescreening.service';
import { JOB_NAMES, JobName, JobResult } from './job-catalogue';

/**
 * The single implementation of "run one named job", extracted from
 * `JobsController` (ADR 0009 §2.3).
 *
 * **Why this exists.** ADR 0007 D7 stated the operator job-run route would
 * "delegate to the same `JobRunService` the existing `/jobs/:job`
 * (machine, `CronSecretGuard`) already calls" — imprecise in a way that
 * mattered: `JobRunService` only *records* outcomes (`.record()`,
 * `.lastRunMap()`); it never owned the per-job dispatch table. That table
 * was a private method on `JobsController` (`handlerFor`, closing over
 * nineteen constructor-injected services) plus the `run()` timing wrapper
 * and `runNamed()` orchestrating them. Reaching that logic from a second,
 * human-operator front door meant either duplicating the `switch` statement
 * (the "two front doors, two implementations that drift the first time a
 * handler changes in one and not the other" failure this ADR exists to
 * avoid) or extracting it once, here.
 *
 * `JobsController.runJobGet`/`runJobPost` are now one-line delegations to
 * `runNamed`. `PlatformJobsController.run` (`platform-jobs.controller.ts`)
 * is the second, human front door this was built for.
 *
 * This is a mechanical, behaviour-preserving move: the same job names, the
 * same 404 on an unrecognised job, the same `run()` timing/logging wrapper,
 * the same `JobRunService.record()` call on both success and failure. Only
 * `AuditService`, `MigrateService` and `ConfigPackLoaderService` — three of
 * the eighteen other constructor params `JobsController` held — are NOT
 * carried over: `AuditService` was already unused by any of this dispatch
 * code (dead injection, confirmed by grep before this extraction), and
 * `MigrateService`/`ConfigPackLoaderService` back the controller's
 * unrelated `POST /jobs/migrate/:target` and `POST /jobs/packs/reload`
 * routes, neither of which goes through `handlerFor` — they stay on
 * `JobsController` directly.
 */
@Injectable()
export class JobDispatchService {
  private readonly logger = new Logger(JobDispatchService.name);

  constructor(
    private readonly slaWatchdogService: SlaWatchdogService,
    private readonly alertRuleService: AlertRuleService,
    private readonly sequenceRunner: SequenceRunnerService,
    private readonly billingService: BillingService,
    private readonly queueService: QueueService,
    private readonly jobProcessor: JobProcessor,
    private readonly taskService: TaskService,
    private readonly notificationsService: NotificationsService,
    private readonly analyticsService: AnalyticsService,
    private readonly retentionService: RetentionService,
    private readonly regulatoryRadar: RegulatoryRadarEngine,
    private readonly jobRunService: JobRunService,
    private readonly rescreeningService: RescreeningService,
    private readonly notificationDispatch: NotificationDispatchService,
    private readonly watchlistIngest: WatchlistIngestService,
    private readonly screeningEngine: ScreeningEngine,
  ) {}

  /**
   * Run one named job to completion, recording the outcome via
   * `JobRunService` on both success and failure, and rethrowing on failure
   * (the caller — a cron route, a tick loop entry, or the operator route —
   * decides what an error means for it).
   */
  async runNamed(job: string): Promise<JobResult> {
    if (!JOB_NAMES.includes(job as JobName)) {
      throw new NotFoundException(
        `Unknown job "${job}". Valid jobs: ${JOB_NAMES.join(', ')}`,
      );
    }

    try {
      const result = await this.run(job, this.handlerFor(job as JobName));
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
      case 'messaging-sequences':
        // Enrols newly-matching records and sends whatever steps are now due.
        // `invalidSequences` in the summary names pack sequences that could
        // not be compiled — a bad stopWhen is the dangerous one, since the
        // sequence would enrol correctly and then never stop.
        return () => this.sequenceRunner.run();
      case 'alert-rules':
        // Evaluates every tenant's `alertRules[]` against its entities. The
        // `invalidRules` array in the summary is the one output worth reading:
        // it names pack rules that could not be compiled and were skipped.
        return () => this.alertRuleService.sweep();
      case 'scheduled-reports':
        return () => this.analyticsService.processScheduledReports();
      case 'daily-billing':
        return () => this.billingService.processDailyBilling();
      case 'regulatory-radar':
        return () => this.regulatoryRadar.scheduledScan();
      case 'audit-archive':
        // Pack-driven per tenant, replacing a hardcoded 365 days that ignored
        // `compliance.retentionYears` entirely — the platform was stating a
        // retention period to regulators and keeping a different one.
        return () => this.retentionService.sweep();
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
