import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JobRun } from './entities/job-run.entity';
import { TenantContext } from '../core/tenancy/tenant-context';

export interface JobStatusRow {
  job: string;
  cadenceMinutes: number;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastStatus: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runCount: number;
  failCount: number;
  /** Past its cadence by more than one full interval. */
  overdue: boolean;
  /** Minutes since the last run, or null if it has never run. */
  minutesSinceLastRun: number | null;
}

/**
 * Durable last-run state for the cron entrypoints.
 *
 * Every write runs as system: `job_runs` is platform-global and its write
 * policy requires the RLS bypass, and a cron invocation has no tenant bound
 * in the first place.
 */
@Injectable()
export class JobRunService {
  private readonly logger = new Logger(JobRunService.name);

  constructor(
    @InjectRepository(JobRun)
    private readonly repo: Repository<JobRun>,
  ) {}

  /** jobName → epoch ms of last run, for cadence checks. */
  async lastRunMap(): Promise<Map<string, number>> {
    return TenantContext.runAsSystem('read job run state', async () => {
      const rows = await this.repo.find();
      return new Map(rows.map((r) => [r.jobName, r.lastRunAt.getTime()]));
    });
  }

  /**
   * Upsert the outcome of a run.
   *
   * `ON CONFLICT` rather than find-then-save: two lambda instances can tick
   * concurrently, and a read-modify-write would lose one of them or violate
   * the unique index. Counters are incremented in SQL for the same reason.
   *
   * Never throws. Bookkeeping failing must not turn a successful job into a
   * reported failure, nor abort the rest of the tick.
   */
  async record(
    jobName: string,
    outcome: { status: 'ok' | 'failed'; durationMs: number; error?: string },
  ): Promise<void> {
    try {
      await TenantContext.runAsSystem('record job run', async () => {
        await this.repo.query(
          // $2 is cast explicitly at every use. Without the casts Postgres
          // sees it as varchar(20) in the column position and as the operand
          // of `= 'ok'` elsewhere, and rejects the whole statement with
          // "inconsistent types deduced for parameter $2".
          `INSERT INTO job_runs
             ("jobName","lastRunAt","lastStatus","lastDurationMs","lastError",
              "lastSuccessAt","runCount","failCount","updatedAt")
           VALUES ($1, now(), $2::text, $3, $4,
                   CASE WHEN $2::text = 'ok' THEN now() ELSE NULL END, 1,
                   CASE WHEN $2::text = 'ok' THEN 0 ELSE 1 END, now())
           ON CONFLICT ("jobName") DO UPDATE SET
             "lastRunAt"      = now(),
             "lastStatus"     = EXCLUDED."lastStatus",
             "lastDurationMs" = EXCLUDED."lastDurationMs",
             "lastError"      = EXCLUDED."lastError",
             -- Preserved on failure: "last succeeded 3 days ago" is the whole
             -- point of the field, so a failing run must not clear it.
             "lastSuccessAt"  = CASE WHEN EXCLUDED."lastStatus" = 'ok'
                                     THEN now() ELSE job_runs."lastSuccessAt" END,
             "runCount"       = job_runs."runCount" + 1,
             "failCount"      = job_runs."failCount" +
                                CASE WHEN EXCLUDED."lastStatus" = 'ok' THEN 0 ELSE 1 END,
             "updatedAt"      = now()`,
          [jobName, outcome.status, outcome.durationMs, outcome.error ?? null],
        );
      });
    } catch (err) {
      // Logged at ERROR, not WARN. Swallowing this quietly is how a broken
      // recorder turns /jobs/status into a page that reports every job as
      // never-run while they are all running fine — the failure is invisible
      // and the symptom points at the wrong subsystem. It stays non-throwing
      // (bookkeeping must not fail the job or abort the rest of the tick) but
      // it must be loud.
      this.logger.error(
        `Could not record run state for '${jobName}' — /jobs/status will be ` +
          `stale for this job: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * Status for every known job, including ones that have never run.
   *
   * A job absent from the table is reported with `lastRunAt: null` and
   * `overdue: true` rather than omitted — a health view that simply does not
   * list a job that has never run is how "sanctions ingest was never
   * scheduled" stays invisible.
   */
  async status(
    cadences: Record<string, number>,
  ): Promise<JobStatusRow[]> {
    const rows = await TenantContext.runAsSystem('read job status', () =>
      this.repo.find(),
    );
    const byName = new Map(rows.map((r) => [r.jobName, r]));
    const now = Date.now();

    return Object.entries(cadences).map(([job, cadenceMinutes]) => {
      const r = byName.get(job);
      const lastRunAt = r?.lastRunAt ?? null;
      const minutesSince = lastRunAt
        ? Math.floor((now - lastRunAt.getTime()) / 60_000)
        : null;

      return {
        job,
        cadenceMinutes,
        lastRunAt,
        lastSuccessAt: r?.lastSuccessAt ?? null,
        lastStatus: r?.lastStatus ?? null,
        lastDurationMs: r?.lastDurationMs ?? null,
        lastError: r?.lastError ?? null,
        runCount: r?.runCount ?? 0,
        failCount: r?.failCount ?? 0,
        // Two full intervals, not one: a scheduler firing on the cadence
        // boundary would otherwise flap between overdue and fine on every
        // poll, and a health tile that alternates is one people learn to
        // ignore.
        overdue:
          minutesSince === null || minutesSince > cadenceMinutes * 2,
        minutesSinceLastRun: minutesSince,
      };
    });
  }
}
