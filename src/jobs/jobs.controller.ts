import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { Public } from '../iam/decorators/public.decorator';
import { CronSecretGuard } from './cron-secret.guard';
import { JobRunService } from './job-run.service';
import { MigrateService, MigrateTarget } from './migrate.service';
import { ConfigPackLoaderService } from '../tenant/services/config-pack-loader.service';
import { JobDispatchService } from './job-dispatch.service';
import {
  JOB_CADENCE_MINUTES,
  JOB_NAMES,
  JobName,
  JobResult,
  TICK_BUDGET_MS,
  TICK_SCOPES,
  TickResult,
  TickScope,
} from './job-catalogue';

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
 *
 * As of ADR 0009 §2.3, the actual per-job dispatch table (`handlerFor`, the
 * `run()` timing wrapper, `runNamed`) lives in `JobDispatchService`
 * (`job-dispatch.service.ts`), not here — this controller is now the HTTP
 * front door (`CronSecretGuard`) onto that one implementation, and
 * `PlatformJobsController` (`platform-jobs.controller.ts`) is the second,
 * human-operator front door onto the same service.
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
    private readonly migrateService: MigrateService,
    private readonly jobRunService: JobRunService,
    private readonly configPackLoader: ConfigPackLoaderService,
    private readonly jobDispatchService: JobDispatchService,
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

  @Post('packs/reload')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reload config packs from disk and report what changed',
    description:
      'Machine endpoint (CRON_SECRET). Runs the same loader as application ' +
      'boot, but returns a per-pack report: file version, stored version read ' +
      'back after the write, and whether the two match. Exists because the ' +
      'loader used to be a boot-time side effect that logged and returned ' +
      'nothing, and two of its failure modes are silent — the packs directory ' +
      'missing from the deployment bundle, and an UPDATE filtered to zero rows ' +
      'by config_packs RLS. Either leaves a pack permanently one version ' +
      'behind the file that defines it, with no error anywhere.',
  })
  @ApiResponse({ status: 200, description: 'Load report' })
  async reloadPacks() {
    return this.configPackLoader.reload();
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
  // One-line delegations to JobDispatchService (ADR 0009 §2.3) — this
  // controller no longer owns the dispatch table itself.

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
    return this.runAndMark(job);
  }

  @Post(':job')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run a single scheduled job by name' })
  @ApiParam({ name: 'job', enum: JOB_NAMES, description: 'Job name' })
  @ApiResponse({ status: 200, description: 'Job completed successfully' })
  @ApiResponse({ status: 404, description: 'Unknown job name' })
  @ApiResponse({ status: 500, description: 'Job failed' })
  async runJobPost(@Param('job') job: string): Promise<JobResult> {
    return this.runAndMark(job);
  }

  /**
   * Dispatch, then mark the job as just-run in the in-memory cadence hint.
   *
   * The private `runNamed` this replaced did the `lastRun.set` itself, and the
   * extraction to `JobDispatchService` dropped it — the service has no access
   * to this controller's map. Without it a manual run does not suppress the
   * next `/jobs/tick`, so a job invoked by hand could run again immediately.
   * Low impact (the map is a de-duplication hint, not a schedule of record;
   * handlers are idempotent; it resets on cold start) — but the extraction
   * claimed to be behaviour-preserving, and this is the one place it was not.
   */
  private async runAndMark(job: string): Promise<JobResult> {
    const result = await this.jobDispatchService.runNamed(job);
    this.lastRun.set(job as JobName, Date.now());
    return result;
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
        // JobDispatchService.runNamed already records the outcome via
        // JobRunService (success and failure) — this loop must NOT also
        // call jobRunService.record() itself, or every dispatched job would
        // be recorded twice per tick.
        const result = await this.jobDispatchService.runNamed(job);
        ran.push(result);
        this.lastRun.set(job, Date.now());
      } catch (error) {
        // A failing job must not abort the rest of the tick.
        const message =
          error instanceof Error ? error.message : String(error ?? 'unknown');
        failed.push({ job, message });
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
}
