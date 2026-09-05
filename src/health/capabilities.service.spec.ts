import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { CapabilitiesService } from './capabilities.service';

/**
 * The report is only worth having if `unconfigured` is reachable. A version
 * that always answers `live` would be indistinguishable from a working
 * deployment, which is the exact failure it exists to catch.
 */
describe('CapabilitiesService', () => {
  const build = (env: Record<string, string>, dataSource?: DataSource) => {
    const config = {
      get: (key: string) => env[key],
    } as unknown as ConfigService;
    return new CapabilitiesService(config, dataSource);
  };

  /** A database whose `watchlist_entries` holds `n` rows, or that throws. */
  const dbWith = (n: number | Error): DataSource =>
    ({
      query: async () => {
        if (n instanceof Error) throw n;
        return [{ n }];
      },
    }) as unknown as DataSource;

  // process.env is consulted as a fallback, so it has to be neutralised or the
  // developer's own .env decides the result of every assertion below.
  const saved = process.env;
  beforeEach(() => {
    process.env = {} as NodeJS.ProcessEnv;
  });
  afterAll(() => {
    process.env = saved;
  });

  const find = async (svc: CapabilitiesService, capability: string) =>
    (await svc.report()).find((c) => c.capability === capability)!;

  it('reports unconfigured when the credential is absent', async () => {
    // `ai` now also probes the database (zero tenant AI connectors), so this
    // needs a DataSource to land on `unconfigured` rather than `unknown` —
    // see the dedicated `describe('ai')` block below for that distinction.
    const svc = build({}, dbWith(0));
    expect((await find(svc, 'mail')).status).toBe('unconfigured');
    expect((await find(svc, 'storage')).status).toBe('unconfigured');
    expect((await find(svc, 'ai')).status).toBe('unconfigured');
    expect((await find(svc, 'scheduler')).status).toBe('unconfigured');
    expect((await find(svc, 'billing')).status).toBe('unconfigured');
  });

  it('names the exact env var that fixes it', async () => {
    const svc = build({}, dbWith(0));
    expect((await find(svc, 'mail')).reason).toContain('RESEND_API_KEY');
    expect((await find(svc, 'ai')).reason).toContain('OPENAI_API_KEY');
    expect((await find(svc, 'scheduler')).reason).toContain('CRON_SECRET');
  });

  it('reports live once every required credential is present', async () => {
    const svc = build({ RESEND_API_KEY: 're_x', RESEND_FROM: 'Meru <a@b.com>' });
    expect((await find(svc, 'mail')).status).toBe('live');
  });

  it('distinguishes degraded from unconfigured', async () => {
    // Transport present, sender not: mail sends, but from a shared default.
    // That is materially different from mail being off, and collapsing the two
    // would hide a deliverability problem behind a green tick.
    const svc = build({ RESEND_API_KEY: 're_x' });
    expect((await find(svc, 'mail')).status).toBe('degraded');
    expect((await find(svc, 'mail')).reason).toContain('RESEND_FROM');
  });

  it('treats whitespace and empty string as absent', async () => {
    // A Vercel env var set to "" is the commonest way a credential looks
    // present and is not. Pinned to zero tenant connectors so the result is
    // `unconfigured`, not `unknown` for want of a DataSource.
    expect(
      (await find(build({ OPENAI_API_KEY: '' }, dbWith(0)), 'ai')).status,
    ).toBe('unconfigured');
    expect(
      (await find(build({ OPENAI_API_KEY: '   ' }, dbWith(0)), 'ai')).status,
    ).toBe('unconfigured');
  });

  it('marks every regulator adapter sandbox, credentialed or not', async () => {
    const withKey = build({ CBUAE_API_KEY: 'k' });
    const cbuae = await find(withKey, 'regulator:ae-cbuae');
    expect(cbuae.sandbox).toBe(true);
    expect(cbuae.reason).toContain('SANDBOX');

    const without = await find(build({}), 'regulator:ae-cbuae');
    expect(without.sandbox).toBe(true);
    expect(without.status).toBe('unconfigured');
  });

  it('covers all eight regulator adapters', async () => {
    const codes = (await build({}).report())
      .filter((c) => c.capability.startsWith('regulator:'))
      .map((c) => c.capability);
    expect(codes).toHaveLength(8);
  });

  it('summary counts without leaking reasons', async () => {
    const svc = build({ OPENAI_API_KEY: 'k' });
    const summary = await svc.summary();
    expect(summary.live).toBeGreaterThan(0);
    expect(summary.unconfigured).toBeGreaterThan(0);
    expect(Object.keys(summary).sort()).toEqual([
      'degraded',
      'live',
      'unconfigured',
      'unknown',
    ]);
  });

  describe('storage', () => {
    it('is live with Supabase alone', async () => {
      const c = await find(
        build({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }),
        'storage',
      );
      expect(c.status).toBe('live');
    });

    it('is degraded when both drivers are credentialed and none is chosen', async () => {
      const c = await find(
        build({
          SUPABASE_URL: 'u',
          SUPABASE_SERVICE_ROLE_KEY: 'k',
          AWS_ACCESS_KEY_ID: 'a',
          AWS_SECRET_ACCESS_KEY: 's',
          AWS_S3_BUCKET: 'b',
        }),
        'storage',
      );
      expect(c.status).toBe('degraded');
      expect(c.reason).toContain('STORAGE_PROVIDER');
    });

    it('is unconfigured when STORAGE_PROVIDER names an uncredentialed driver', async () => {
      const c = await find(
        build({ STORAGE_PROVIDER: 'supabase', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's', AWS_S3_BUCKET: 'b' }),
        'storage',
      );
      expect(c.status).toBe('unconfigured');
    });
  });

  /**
   * `ai` is `live` on the platform key alone — `AiService.clientFor` checks
   * the tenant's own connector FIRST, so a deployment can be fully live for
   * every tenant that has connected one even with no platform key. Reporting
   * `unconfigured` in that state told an operator to spend a credential the
   * product did not need.
   */
  describe('ai', () => {
    it('is live on the platform key alone, without needing the database', async () => {
      const c = await find(build({ OPENAI_API_KEY: 'k' }), 'ai');
      expect(c.status).toBe('live');
    });

    it('is degraded, not unconfigured, when tenants have connected their own provider', async () => {
      const c = await find(build({}, dbWith(3)), 'ai');
      expect(c.status).toBe('degraded');
      expect(c.reason).toContain('3 tenant');
      expect(c.reason).not.toContain('Every AI feature is off');
    });

    it('is unconfigured only when no platform key AND no tenant connector', async () => {
      const c = await find(build({}, dbWith(0)), 'ai');
      expect(c.status).toBe('unconfigured');
    });

    it('is unknown, never unconfigured, when the connector count cannot be read', async () => {
      expect((await find(build({}), 'ai')).status).toBe('unknown');
      expect(
        (await find(build({}, dbWith(new Error('boom'))), 'ai')).status,
      ).toBe('unknown');
    });
  });

  /**
   * screening_lists is decided by the database, not by an env var. The old
   * spec required `SCREENING_LISTS_URL`, which nothing reads: it could be set
   * and screening still returned clean for every name off an empty table.
   */
  describe('screening_lists', () => {
    it('is unconfigured when watchlist_entries is empty, and names the ingest route', async () => {
      const c = await find(build({ CRON_SECRET: 's' }, dbWith(0)), 'screening_lists');
      expect(c.status).toBe('unconfigured');
      expect(c.reason).toContain('POST /api/v1/jobs/watchlist-ingest');
      expect(c.reason).not.toContain('SCREENING_LISTS_URL');
    });

    it('names CRON_SECRET when the table is empty and the ingest cannot be triggered', async () => {
      const c = await find(build({}, dbWith(0)), 'screening_lists');
      expect(c.status).toBe('unconfigured');
      expect(c.reason).toContain('CRON_SECRET');
    });

    it('is unknown, never live, when the table cannot be counted', async () => {
      expect((await find(build({ CRON_SECRET: 's' }), 'screening_lists')).status).toBe('unknown');
      expect(
        (await find(build({ CRON_SECRET: 's' }, dbWith(new Error('boom'))), 'screening_lists'))
          .status,
      ).toBe('unknown');
    });

    it('is degraded when lists are loaded but nothing can refresh them', async () => {
      const c = await find(build({}, dbWith(31_579)), 'screening_lists');
      expect(c.status).toBe('degraded');
      expect(c.reason).toContain('CRON_SECRET');
    });

    it('is live only with rows AND a schedulable ingest', async () => {
      const c = await find(build({ CRON_SECRET: 's' }, dbWith(31_579)), 'screening_lists');
      expect(c.status).toBe('live');
    });
  });
});
