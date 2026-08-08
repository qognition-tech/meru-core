import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConnectorsService } from './connectors.service';
import { TenantConnector } from '../entities/tenant-connector.entity';
import { IntegrationsService } from '../integrations.service';
import { encryptCredentials } from '../../core/crypto/credential-cipher';

/**
 * "Connect your own AI" — a tenant supplying its own endpoint and key, carried
 * on the existing connector registry rather than a table of its own.
 *
 * The security-relevant assertions here are that a key never comes back out of
 * the API, and that an AI provider cannot be enabled in a state where it will
 * fail later at some unrelated call site.
 */
describe('ConnectorsService — AI providers', () => {
  const find = jest.fn();
  const findOne = jest.fn();
  const save = jest.fn((x: unknown) => Promise.resolve(x));
  const create = jest.fn((x: Record<string, unknown>) => ({
    enabled: false,
    mode: 'sandbox',
    credentials: null,
    ...x,
  }));
  let service: ConnectorsService;

  beforeAll(() => {
    // 32 bytes hex — the cipher refuses to run without a key, which is correct.
    process.env.CREDENTIALS_ENCRYPTION_KEY = 'a'.repeat(64);
  });

  beforeEach(async () => {
    [find, findOne, save, create].forEach((m) => m.mockClear());
    find.mockResolvedValue([]);
    findOne.mockResolvedValue(null);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ConnectorsService,
        {
          provide: getRepositoryToken(TenantConnector),
          useValue: { find, findOne, save, create },
        },
        {
          provide: IntegrationsService,
          useValue: { listAdapters: () => [] },
        },
      ],
    }).compile();

    service = moduleRef.get(ConnectorsService);
  });

  it('offers AI providers to every vertical, unlike the regulators', async () => {
    const forBanking = await service.listForTenant('t1', 'grc');
    const forImmigration = await service.listForTenant('t1', 'immigration');
    // A firm and a bank both use AI; only the regulator list is vertical-bound.
    const codes = (rows: Array<{ id: string; kind: string }>) =>
      rows.filter((r) => r.kind === 'ai_provider').map((r) => r.id);

    expect(codes(forBanking as never)).toEqual(
      codes(forImmigration as never),
    );
    expect(codes(forBanking as never)).toContain('custom-openai-compatible');
  });

  it('reports hasCredentials but never the key itself', async () => {
    find.mockResolvedValue([
      {
        adapterCode: 'openai',
        enabled: true,
        credentials: encryptCredentials({ apiKey: 'sk-secret-value' }),
      },
    ]);

    const list = await service.listForTenant('t1', 'immigration');
    const openai = (list as Array<Record<string, unknown>>).find(
      (r) => r.id === 'openai',
    )!;

    expect(openai.hasCredentials).toBe(true);
    // The whole payload, not just the field: a key must not reach a browser by
    // any route, including one nobody thought to check.
    expect(JSON.stringify(list)).not.toContain('sk-secret-value');
  });

  it('refuses to enable an AI provider with no credentials', async () => {
    // Enabling one without a key would surface later as an opaque upstream
    // error on whatever feature happened to call the gateway first.
    await expect(
      service.upsert('t1', 'immigration', 'openai', { enabled: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a custom provider with no baseUrl', async () => {
    await expect(
      service.upsert('t1', 'immigration', 'custom-openai-compatible', {
        enabled: true,
        credentials: { apiKey: 'k' },
      }),
    ).rejects.toThrow(/baseUrl/);
  });

  it('accepts a custom self-hosted endpoint with no API key', async () => {
    // A vLLM or Ollama instance on a private network legitimately needs none.
    const saved = await service.upsert(
      't1',
      'immigration',
      'custom-openai-compatible',
      {
        enabled: true,
        credentials: { baseUrl: 'http://vllm.internal:8000/v1', model: 'llama-3.1-70b' },
      },
    );

    expect(saved.hasCredentials).toBe(true);
    expect('credentials' in saved).toBe(false);
  });

  it('is not bound by the vertical allow-list that governs regulators', async () => {
    // 'openai' is in no VERTICAL_ADAPTERS entry, so the regulator check would
    // have rejected it.
    await expect(
      service.upsert('t1', 'immigration', 'openai', {
        credentials: { apiKey: 'sk-x' },
      }),
    ).resolves.toMatchObject({ hasCredentials: true });
  });

  it('still rejects an unknown regulator adapter', async () => {
    await expect(
      service.upsert('t1', 'immigration', 'uae-central-bank', {}),
    ).rejects.toThrow(/not available for the 'immigration' vertical/);
  });

  it('resolves a connected provider, filling defaults from the catalogue', async () => {
    find.mockResolvedValue([
      {
        adapterCode: 'openai',
        enabled: true,
        credentials: encryptCredentials({ apiKey: 'sk-live' }),
      },
    ]);

    const provider = await service.resolveAiProvider('t1');

    expect(provider).toEqual({
      adapterCode: 'openai',
      apiKey: 'sk-live',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    });
  });

  it('returns null when nothing is connected, rather than throwing', async () => {
    // A tenant with no provider is normal; the caller answers it by falling
    // back to the platform key.
    find.mockResolvedValue([]);
    await expect(service.resolveAiProvider('t1')).resolves.toBeNull();
  });

  it('ignores a disabled provider row', async () => {
    // `find` is filtered on enabled:true, so a disabled row never arrives —
    // asserted here so the filter cannot be dropped silently.
    find.mockResolvedValue([]);
    await expect(service.resolveAiProvider('t1')).resolves.toBeNull();
    expect(find).toHaveBeenCalledWith({
      where: { tenantId: 't1', enabled: true },
    });
  });
});
