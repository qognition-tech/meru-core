import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TenantContext } from '../core/tenancy/tenant-context';
import { AI_PROVIDER_ADAPTERS } from '../integrations/services/connectors.service';

/**
 * What this deployment can actually do, decided by which credentials are set.
 *
 * Five credentials are unset in production today and every one of them breaks
 * something *quietly*. A provisioned tenant admin never receives their invite
 * and `POST /tenants/signup` still answers 200. Document upload times out as a
 * 500 rather than saying storage is off. Every scheduled job — including the
 * daily rescreening CBUAE Rulebook §3.4.1 mandates and the sanctions-list
 * ingest — runs ZERO times, because `CronSecretGuard` fails closed without
 * `CRON_SECRET` and both Vercel crons answer 401.
 *
 * This reports; it does NOT enforce. A missing credential must never take the
 * API down: an immigration tenant doing casework has no interest in whether
 * Stripe is wired, and refusing to boot over it would convert a degraded
 * feature into a total outage. Callers that need a capability answer 503 with
 * `unavailableReason` at their own entry point (see `StripeService`, which
 * already does this correctly).
 *
 * `unconfigured` means "no credential" — for the eight regulator adapters that
 * is the *expected* state, because regulator API access requires an approved
 * application with the authority. It is never evidence of a fault, and it must
 * never be reported as `live`.
 */

/**
 * `unknown` is for a capability whose state lives in the database and could
 * not be probed. It is never folded into `live`: an unprobed dependency
 * reported as working is the lie this report exists to stop.
 */
export type CapabilityStatus = 'live' | 'degraded' | 'unconfigured' | 'unknown';

export interface CapabilityReport {
  capability: string;
  status: CapabilityStatus;
  /** Plain-language reason. For `unconfigured`, names the exact env var. */
  reason: string;
  /** True for the eight regulator adapters, which are sandbox by design. */
  sandbox?: boolean;
}

interface CapabilitySpec {
  capability: string;
  /** All must be present for `live`. */
  requires: string[];
  /** Present but incomplete → `degraded` rather than `unconfigured`. */
  partial?: string[];
  sandbox?: boolean;
  describe: (missing: string[]) => string;
}

/**
 * The eight regulator adapters, with the credentials each actually reads.
 *
 * These MUST match the `credentialsPresent` predicate in the matching
 * `src/integrations/adapters/<adapter>.adapter.ts`, and
 * `capabilities-regulators.spec.ts` parses those files and fails if they
 * diverge — because writing the discipline down was not enough. This list was
 * authored with that instruction in its own comment and still drifted in SEVEN
 * of eight rows: three named a `*_API_KEY` no adapter reads, three checked only
 * the client id and not the secret, and the UK row named
 * `UK_HOMEOFFICE_CLIENT_ID` where the adapter reads `UKVI_*`.
 *
 * Both halves of a credential pair are required, because an adapter goes live
 * only when it has both. Reporting `live` on the id alone says a regulator
 * connector is configured while it is in fact still sandboxed — the exact
 * "unknown rendered as a positive result" failure §5.2 exists to prevent.
 */
const REGULATORS: Array<{ code: string; adapter: string; requires: string[] }> = [
  {
    code: 'regulator:ae-cbuae',
    adapter: 'uae-central-bank',
    requires: ['CBUAE_API_KEY'],
  },
  {
    code: 'regulator:sa-sama',
    adapter: 'sa-sama',
    requires: ['SAMA_CLIENT_ID', 'SAMA_CLIENT_SECRET'],
  },
  {
    code: 'regulator:qa-central-bank',
    adapter: 'qa-central-bank',
    requires: ['QCB_CLIENT_ID', 'QCB_CLIENT_SECRET'],
  },
  {
    code: 'regulator:bh-central-bank',
    adapter: 'bh-central-bank',
    requires: ['CBB_CLIENT_ID', 'CBB_CLIENT_SECRET'],
  },
  {
    code: 'regulator:au-home-affairs',
    adapter: 'au-home-affairs',
    requires: ['AU_HOMEAFFAIRS_CLIENT_ID', 'AU_HOMEAFFAIRS_CLIENT_SECRET'],
  },
  {
    code: 'regulator:ca-ircc',
    adapter: 'ca-ircc',
    requires: ['IRCC_CLIENT_ID', 'IRCC_CLIENT_SECRET'],
  },
  {
    code: 'regulator:uk-home-office',
    adapter: 'uk-home-office',
    requires: ['UKVI_CLIENT_ID', 'UKVI_CLIENT_SECRET'],
  },
  {
    code: 'regulator:nz-immigration',
    adapter: 'nz-immigration',
    requires: ['INZ_CLIENT_ID', 'INZ_CLIENT_SECRET'],
  },
];

/** Exported only so the spec can hold this list against the adapter sources. */
export const REGULATOR_CREDENTIALS = REGULATORS;

const SPECS: CapabilitySpec[] = [
  {
    capability: 'mail',
    requires: ['RESEND_API_KEY'],
    partial: ['RESEND_FROM'],
    describe: (missing) =>
      missing.includes('RESEND_API_KEY')
        ? 'No mail transport. Tenant invites are generated but never delivered, ' +
          'so a provisioned admin cannot sign in. Set RESEND_API_KEY.'
        : 'Sending from the Resend shared default. Set RESEND_FROM to a verified ' +
          'sender or delivery will be unreliable.',
  },
  {
    capability: 'scheduler',
    requires: ['CRON_SECRET'],
    describe: () =>
      'CronSecretGuard fails closed, so /jobs/tick answers 401 to everyone — ' +
      'including the two Vercel crons — and every scheduled job runs ZERO ' +
      'times: SLA watchdog, alert sweep, sequence runner, rescreening and the ' +
      'sanctions-list ingest. Daily rescreening is mandated, so this is a ' +
      'compliance gap, not a latency one. Set CRON_SECRET and point a ' +
      'scheduler at the tick.',
  },
  {
    capability: 'billing',
    requires: ['STRIPE_SECRET_KEY'],
    partial: ['STRIPE_WEBHOOK_SECRET'],
    describe: (missing) =>
      missing.includes('STRIPE_SECRET_KEY')
        ? 'Checkout and the customer portal answer 503. Set STRIPE_SECRET_KEY.'
        : 'Checkout works but subscription state will drift: nothing verifies ' +
          'incoming webhooks. Set STRIPE_WEBHOOK_SECRET.',
  },
];

@Injectable()
export class CapabilitiesService implements OnModuleInit {
  private readonly logger = new Logger(CapabilitiesService.name);

  constructor(
    private readonly config: ConfigService,
    // Optional so the unit tests can construct the service without a database;
    // without it the screening_lists probe reports `unknown`, never `live`.
    @Optional() @InjectDataSource() private readonly dataSource?: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    const report = await this.report();
    const unconfigured = report.filter(
      (c) => c.status === 'unconfigured' || c.status === 'unknown',
    );
    if (unconfigured.length === 0) {
      this.logger.log('All capabilities configured.');
      return;
    }

    // One block rather than one line each: a boot log scrolls, and five
    // separate warnings interleaved with module-init noise get skimmed past.
    const lines = unconfigured.map((c) => `  • ${c.capability} — ${c.reason}`);
    this.logger.warn(
      `${unconfigured.length} capabilities are UNCONFIGURED or UNKNOWN and will fail ` +
        `quietly at the point of use:\n${lines.join('\n')}\n` +
        `GET /health/capabilities has the full report.`
    );
  }

  private has(key: string): boolean {
    const v = this.config.get<string>(key) ?? process.env[key];
    return typeof v === 'string' && v.trim().length > 0;
  }

  private evaluate(spec: CapabilitySpec): CapabilityReport {
    const missingRequired = spec.requires.filter((k) => !this.has(k));
    if (missingRequired.length > 0) {
      return {
        capability: spec.capability,
        status: 'unconfigured',
        reason: spec.describe(missingRequired),
        ...(spec.sandbox ? { sandbox: true } : {}),
      };
    }

    const missingPartial = (spec.partial ?? []).filter((k) => !this.has(k));
    if (missingPartial.length > 0) {
      return {
        capability: spec.capability,
        status: 'degraded',
        reason: spec.describe(missingPartial),
        ...(spec.sandbox ? { sandbox: true } : {}),
      };
    }

    return {
      capability: spec.capability,
      status: 'live',
      reason: 'Configured.',
      ...(spec.sandbox ? { sandbox: true } : {}),
    };
  }

  /**
   * Rows in `watchlist_entries`, or `null` when it could not be counted.
   *
   * Counted rather than inferred from an env var: the ingest reads hardcoded
   * public feeds (OFAC SDN, UN, EU, UK OFSI) and needs no URL, so the only
   * thing that says whether a real name can match is whether the table has
   * rows. A previous version of this report demanded `SCREENING_LISTS_URL`,
   * which nothing in `src/` reads — it could be set or unset with no effect on
   * screening whatsoever.
   */
  private async watchlistCount(): Promise<number | null> {
    if (!this.dataSource) return null;
    try {
      const rows = await TenantContext.runAsSystem(
        'capabilities: count watchlist_entries',
        () =>
          this.dataSource!.query(
            'SELECT COUNT(*)::int AS n FROM "watchlist_entries"',
          ),
      );
      const n = Number(rows?.[0]?.n);
      return Number.isFinite(n) ? n : null;
    } catch (err) {
      this.logger.warn(
        `Could not count watchlist_entries: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * Sanctions screening is only real when two things hold: the ingest job can
   * be triggered (`CRON_SECRET`, because `CronSecretGuard` fails closed and
   * `/jobs/*` answers 401 without it) AND it has actually run at least once
   * (`watchlist_entries` has rows). Neither is a URL.
   */
  private async evaluateScreeningLists(): Promise<CapabilityReport> {
    const capability = 'screening_lists';
    const hasSecret = this.has('CRON_SECRET');
    const count = await this.watchlistCount();

    const ingestFix =
      'Set CRON_SECRET, then run the ingest once by hand: ' +
      'POST /api/v1/jobs/watchlist-ingest with ' +
      '`Authorization: Bearer <CRON_SECRET>` (AGENTS.md §5), and schedule ' +
      '/jobs/tick?scope=daily so it keeps refreshing.';

    if (count === 0) {
      return {
        capability,
        status: 'unconfigured',
        reason:
          'watchlist_entries is EMPTY: no sanctions list has ever been ' +
          'ingested, so a sanctioned name CANNOT match. POST /engines/screening ' +
          'answers 503 with listsLoaded:false rather than a clean result. ' +
          (hasSecret
            ? 'CRON_SECRET is set but the ingest has not run. '
            : 'CRON_SECRET is unset, so the ingest job cannot even be triggered. ') +
          ingestFix,
      };
    }

    if (count === null) {
      return {
        capability,
        status: 'unknown',
        reason:
          'watchlist_entries could not be counted (no database, or the query ' +
          'failed), so whether screening can match a real name is unknown. ' +
          'Read GET /engines/screening/watchlist-status before trusting a screen.',
      };
    }

    if (!hasSecret) {
      return {
        capability,
        status: 'degraded',
        reason:
          `${count} sanctions entries are loaded, but CRON_SECRET is unset so ` +
          'nothing can re-run the ingest: the lists will go stale and ' +
          'GET /engines/screening/watchlist-status will start naming stale ' +
          'feeds. ' +
          ingestFix,
      };
    }

    return {
      capability,
      status: 'live',
      reason: `${count} sanctions entries loaded; ingest is schedulable.`,
    };
  }

  /**
   * Tenants with their own connected AI provider (`PUT
   * /integrations/connectors/{code}`), counted the same way `watchlistCount`
   * counts ingested sanctions rows: DB truth, not an env var.
   *
   * This exists because `AiService.clientFor` checks the tenant's connector
   * BEFORE the platform key (`ai.service.ts`), so `OPENAI_API_KEY` alone was
   * never the right signal — a deployment with no platform key can still be
   * fully live for every tenant that has connected DeepSeek, Anthropic or a
   * self-hosted endpoint. Reporting `unconfigured` in that state told an
   * operator to spend a credential the product did not need, while filing a
   * genuine per-tenant model-pin defect as a missing key.
   */
  private async tenantAiConnectorCount(): Promise<number | null> {
    if (!this.dataSource) return null;
    try {
      const codes = AI_PROVIDER_ADAPTERS.map((a) => a.id);
      const rows = await TenantContext.runAsSystem(
        'capabilities: count tenant AI connectors',
        () =>
          this.dataSource!.query(
            'SELECT COUNT(*)::int AS n FROM "tenant_connectors" ' +
              'WHERE "adapterCode" = ANY($1) AND "enabled" = true ' +
              'AND "credentials" IS NOT NULL',
            [codes],
          ),
      );
      const n = Number(rows?.[0]?.n);
      return Number.isFinite(n) ? n : null;
    } catch (err) {
      this.logger.warn(
        `Could not count tenant AI connectors: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * `live` when the platform key is set — unchanged. Otherwise the platform
   * key alone is not the whole answer: count tenants who have connected their
   * own provider before calling AI `unconfigured`.
   */
  private async evaluateAi(): Promise<CapabilityReport> {
    const capability = 'ai';
    if (this.has('OPENAI_API_KEY')) {
      return { capability, status: 'live', reason: 'Configured.' };
    }

    const count = await this.tenantAiConnectorCount();

    if (count === null) {
      return {
        capability,
        status: 'unknown',
        reason:
          'No platform OPENAI_API_KEY, and tenant AI connectors could not ' +
          'be counted (no database, or the query failed), so whether any ' +
          'tenant can reach AI right now is unknown.',
      };
    }

    if (count > 0) {
      return {
        capability,
        status: 'degraded',
        reason:
          `No platform OPENAI_API_KEY. ${count} tenant(s) have connected ` +
          'their own AI provider and are served from it; tenants without ' +
          'one get 503 on every AI call. Set OPENAI_API_KEY for ' +
          'platform-wide coverage, or have the remaining tenants connect a ' +
          'provider under PUT /integrations/connectors/{code}.',
      };
    }

    return {
      capability,
      status: 'unconfigured',
      reason:
        'Every AI feature is off: regulatory radar, document-intelligence ' +
        'OCR, natural-language GRC and the assistant. No tenant has ' +
        'connected their own provider either. Set OPENAI_API_KEY, or have a ' +
        'tenant connect one under PUT /integrations/connectors/{code}.',
    };
  }

  /**
   * Object storage is live with EITHER driver credentialed. Two credentialed
   * drivers without STORAGE_PROVIDER is degraded: the registry refuses to
   * guess between them and uploads answer 503 until one is chosen.
   */
  private evaluateStorage(): CapabilityReport {
    const capability = 'storage';
    const s3 = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_S3_BUCKET'];
    const supabase = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
    const hasS3 = s3.every((k) => this.has(k));
    const hasSupabase = supabase.every((k) => this.has(k));
    const chosen = (this.config.get<string>('STORAGE_PROVIDER') ?? '').trim();

    if (!hasS3 && !hasSupabase) {
      return {
        capability,
        status: 'unconfigured',
        reason:
          'Document upload and download answer 503: no object store is ' +
          'credentialed. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY ' +
          '(+ SUPABASE_STORAGE_BUCKET, private bucket) or ' +
          `${s3.join(' + ')}.`,
      };
    }
    if (hasS3 && hasSupabase && !['s3', 'supabase'].includes(chosen)) {
      return {
        capability,
        status: 'degraded',
        reason:
          'Both S3 and Supabase are credentialed and STORAGE_PROVIDER does ' +
          'not choose between them; new uploads are refused until it is set ' +
          'to s3 or supabase.',
      };
    }
    if (chosen && chosen !== 's3' && chosen !== 'supabase') {
      return {
        capability,
        status: 'degraded',
        reason: `STORAGE_PROVIDER=${chosen} names no driver. Use s3 or supabase.`,
      };
    }
    if (
      (chosen === 's3' && !hasS3) ||
      (chosen === 'supabase' && !hasSupabase)
    ) {
      return {
        capability,
        status: 'unconfigured',
        reason:
          `STORAGE_PROVIDER=${chosen} but that driver has no credentials; ` +
          'uploads are refused.',
      };
    }
    return {
      capability,
      status: 'live',
      reason: `Configured (${chosen || (hasSupabase ? 'supabase' : 's3')}).`,
    };
  }

  /** The full report. Guarded to platform_admin — it names env vars. */
  async report(): Promise<CapabilityReport[]> {
    const core = [
      ...SPECS.map((s) => this.evaluate(s)),
      this.evaluateStorage(),
      await this.evaluateScreeningLists(),
      await this.evaluateAi(),
    ];

    const regulators = REGULATORS.map(({ code, requires }) =>
      this.evaluate({
        capability: code,
        requires,
        sandbox: true,
        describe: (missing) =>
          `No credential, which is the expected state: regulator API access ` +
          `requires an approved application with the authority. Missing: ` +
          `${missing.join(', ')}.`,
      })
    ).map((r) => ({
      ...r,
      // Every adapter is sandbox even when credentialed. A UI implying live
      // regulator data is the worst failure mode this product has, so the flag
      // is unconditional rather than derived from whether a key is present.
      sandbox: true,
      reason:
        r.status === 'live'
          ? 'Credentialed, but SANDBOX — this is not live regulator data.'
          : r.reason,
    }));

    return [...core, ...regulators];
  }

  /**
   * Counts only — no reasons, no env var names. `GET /health` is public, and
   * an unauthenticated caller learning exactly which credentials are absent is
   * a reconnaissance gift.
   */
  async summary(): Promise<Record<CapabilityStatus, number>> {
    const counts: Record<CapabilityStatus, number> = {
      live: 0,
      degraded: 0,
      unconfigured: 0,
      unknown: 0,
    };
    for (const c of await this.report()) counts[c.status] += 1;
    return counts;
  }
}
