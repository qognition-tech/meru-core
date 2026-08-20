import { ConfigService } from '@nestjs/config';
import { CapabilitiesService } from './capabilities.service';

/**
 * The report is only worth having if `unconfigured` is reachable. A version
 * that always answers `live` would be indistinguishable from a working
 * deployment, which is the exact failure it exists to catch.
 */
describe('CapabilitiesService', () => {
  const build = (env: Record<string, string>) => {
    const config = {
      get: (key: string) => env[key],
    } as unknown as ConfigService;
    return new CapabilitiesService(config);
  };

  // process.env is consulted as a fallback, so it has to be neutralised or the
  // developer's own .env decides the result of every assertion below.
  const saved = process.env;
  beforeEach(() => {
    process.env = {} as NodeJS.ProcessEnv;
  });
  afterAll(() => {
    process.env = saved;
  });

  const find = (svc: CapabilitiesService, capability: string) =>
    svc.report().find((c) => c.capability === capability)!;

  it('reports unconfigured when the credential is absent', () => {
    const svc = build({});
    expect(find(svc, 'mail').status).toBe('unconfigured');
    expect(find(svc, 'storage').status).toBe('unconfigured');
    expect(find(svc, 'ai').status).toBe('unconfigured');
    expect(find(svc, 'scheduler').status).toBe('unconfigured');
    expect(find(svc, 'billing').status).toBe('unconfigured');
    expect(find(svc, 'screening_lists').status).toBe('unconfigured');
  });

  it('names the exact env var that fixes it', () => {
    const svc = build({});
    expect(find(svc, 'mail').reason).toContain('RESEND_API_KEY');
    expect(find(svc, 'ai').reason).toContain('OPENAI_API_KEY');
    expect(find(svc, 'scheduler').reason).toContain('CRON_SECRET');
  });

  it('reports live once every required credential is present', () => {
    const svc = build({ RESEND_API_KEY: 're_x', RESEND_FROM: 'Meru <a@b.com>' });
    expect(find(svc, 'mail').status).toBe('live');
  });

  it('distinguishes degraded from unconfigured', () => {
    // Transport present, sender not: mail sends, but from a shared default.
    // That is materially different from mail being off, and collapsing the two
    // would hide a deliverability problem behind a green tick.
    const svc = build({ RESEND_API_KEY: 're_x' });
    expect(find(svc, 'mail').status).toBe('degraded');
    expect(find(svc, 'mail').reason).toContain('RESEND_FROM');
  });

  it('treats whitespace and empty string as absent', () => {
    // A Vercel env var set to "" is the commonest way a credential looks
    // present and is not.
    expect(find(build({ OPENAI_API_KEY: '' }), 'ai').status).toBe('unconfigured');
    expect(find(build({ OPENAI_API_KEY: '   ' }), 'ai').status).toBe('unconfigured');
  });

  it('marks every regulator adapter sandbox, credentialed or not', () => {
    const withKey = build({ CBUAE_API_KEY: 'k' });
    const cbuae = find(withKey, 'regulator:ae-cbuae');
    expect(cbuae.sandbox).toBe(true);
    expect(cbuae.reason).toContain('SANDBOX');

    const without = find(build({}), 'regulator:ae-cbuae');
    expect(without.sandbox).toBe(true);
    expect(without.status).toBe('unconfigured');
  });

  it('covers all eight regulator adapters', () => {
    const codes = build({})
      .report()
      .filter((c) => c.capability.startsWith('regulator:'))
      .map((c) => c.capability);
    expect(codes).toHaveLength(8);
  });

  it('summary counts without leaking reasons', () => {
    const svc = build({ OPENAI_API_KEY: 'k' });
    const summary = svc.summary();
    expect(summary.live).toBeGreaterThan(0);
    expect(summary.unconfigured).toBeGreaterThan(0);
    expect(Object.keys(summary).sort()).toEqual([
      'degraded',
      'live',
      'unconfigured',
    ]);
  });
});
