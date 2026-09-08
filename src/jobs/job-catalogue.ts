/**
 * The static shape of "what jobs exist and how often they run" — pulled out
 * of `jobs.controller.ts` so both `JobsController` (tick/status routes) and
 * `JobDispatchService` (ADR 0009 §2.3, actual per-job dispatch) can depend on
 * it without depending on EACH OTHER. `JobsController` injects
 * `JobDispatchService`; if `JobDispatchService` in turn imported `JobName`/
 * `JOB_NAMES` back out of `jobs.controller.ts`, that would be a two-file
 * circular import for no reason — the catalogue has no behaviour and belongs
 * on neither side of that relationship.
 */

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
  // Pack-driven alert rules. Every 15 minutes rather than daily: an alert
  // rule can watch a same-day condition (an SLA about to breach, a payment
  // overdue this morning), and a daily sweep would report it once the window
  // it was meant to protect had already closed. Repeat notification is bounded
  // by each rule's own cooldown, not by how often the sweep runs.
  'alert-rules': 15,
  // Pack-driven messaging sequences. Hourly is the right granularity: the
  // shortest delay any authored sequence uses is measured in hours, and
  // sweeping more often would only re-scan the same records for no earlier
  // send — steps are due at a wall-clock offset from enrolment, not on a
  // "next tick" basis.
  'messaging-sequences': 60,
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

export const JOB_NAMES = Object.keys(JOB_CADENCE_MINUTES) as JobName[];

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
export const TICK_SCOPES = {
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
export const TICK_BUDGET_MS = 45_000;
