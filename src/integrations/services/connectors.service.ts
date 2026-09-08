import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ConnectorMode,
  TenantConnector,
} from '../entities/tenant-connector.entity';
import { IntegrationsService } from '../integrations.service';
import {
  decryptCredentials,
  encryptCredentials,
} from '../../core/crypto/credential-cipher';

/**
 * Which regulator adapters each vertical may connect. This is deliberately the
 * ONLY place immigration/banking vocabulary touches the connector layer — the
 * adapters themselves are vertical-neutral, and a new vertical extends this
 * map (eventually: the config pack) rather than the adapter code.
 */
export const VERTICAL_ADAPTERS: Record<string, string[]> = {
  grc: ['uae-central-bank', 'sa-sama', 'qa-central-bank', 'bh-central-bank'],
  immigration: ['au-home-affairs', 'ca-ircc', 'uk-home-office', 'nz-immigration'],
};

/**
 * AI providers a tenant can bring their own key for — "connect your AI".
 *
 * These live in the **same** registry as the regulator connectors rather than
 * in a table of their own, and that is the point. The shape of the problem is
 * identical: a per-tenant, optional, credential-bearing link to an external
 * service, where the credential must be encrypted at rest and must never come
 * back out of the API. That mechanism already exists here, with an AES-256-GCM
 * envelope, a unique index per (tenant, code), and a `hasCredentials` flag
 * instead of the secret. A second table would have duplicated all of it and
 * given the platform two places to leak a key from.
 *
 * Cross-vertical on purpose: an immigration firm and a bank both use AI, so
 * unlike the regulators these are not filtered by vertical.
 *
 * `baseUrl` is what makes this more than a key box. Anything speaking the
 * OpenAI chat-completions protocol — Azure OpenAI, OpenRouter, Together,
 * a self-hosted vLLM or Ollama, an in-house agent gateway — is reachable by
 * pointing `custom-openai-compatible` at it. That covers the open-source and
 * self-hosted cases without Meru shipping an adapter per vendor.
 */
export const AI_PROVIDER_ADAPTERS = [
  {
    id: 'openai',
    label: 'OpenAI',
    docsUrl: 'https://platform.openai.com/api-keys',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    /** Fields the UI should collect. `secret: true` → never render back. */
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, required: true },
      { key: 'model', label: 'Model', secret: false, required: false },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-5',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, required: true },
      { key: 'model', label: 'Model', secret: false, required: false },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    // DeepSeek serves the OpenAI chat-completions protocol verbatim, so it
    // needs no adapter of its own — the existing OpenAI client reaches it by
    // base URL alone. It earns a named entry rather than being left to
    // `custom-openai-compatible` because a tenant admin should not have to know
    // a vendor's base URL to connect a mainstream provider, and because the
    // default model belongs next to the credential rather than in someone's
    // notes.
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    // `deepseek-chat` (V3), not `deepseek-reasoner` (R1). The reasoner emits a
    // long chain-of-thought before its answer, which costs latency and tokens
    // on the short extraction and summarisation prompts the packs actually
    // ship. A pack that wants R1 pins it in `modelConfig.model`, which
    // outranks this.
    defaultModel: 'deepseek-chat',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, required: true },
      { key: 'model', label: 'Model', secret: false, required: false },
    ],
  },
  {
    id: 'custom-openai-compatible',
    label: 'Custom / self-hosted (OpenAI-compatible)',
    docsUrl: null,
    defaultBaseUrl: null,
    defaultModel: null,
    fields: [
      { key: 'baseUrl', label: 'Base URL', secret: false, required: true },
      { key: 'apiKey', label: 'API key', secret: true, required: false },
      { key: 'model', label: 'Model', secret: false, required: true },
    ],
  },
] as const;

const AI_PROVIDER_CODES = AI_PROVIDER_ADAPTERS.map((a) => a.id) as string[];

/** Decrypted AI provider settings, for the AI gateway only. */
export interface ResolvedAiProvider {
  adapterCode: string;
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
}

export interface UpsertConnectorInput {
  enabled?: boolean;
  mode?: ConnectorMode;
  /** Plaintext credentials from the tenant admin — encrypted before storage. */
  credentials?: Record<string, unknown> | null;
}

@Injectable()
export class ConnectorsService {
  constructor(
    @InjectRepository(TenantConnector)
    private readonly connectorRepo: Repository<TenantConnector>,
    private readonly integrationsService: IntegrationsService,
  ) {}

  /** Adapter catalogue for a vertical, merged with the tenant's enablement state. */
  async listForTenant(tenantId: string, vertical: string | null) {
    const allowed = (vertical && VERTICAL_ADAPTERS[vertical]) ?? [];
    const adapters = this.integrationsService
      .listAdapters()
      .filter((a) => allowed.includes(a.id));

    const rows = await this.connectorRepo.find({ where: { tenantId } });
    const byCode = new Map(rows.map((r) => [r.adapterCode, r]));

    const regulators = adapters.map((a) => {
      const row = byCode.get(a.id);
      return {
        ...a,
        kind: 'regulator' as const,
        enabled: row?.enabled ?? false,
        mode: row?.mode ?? ConnectorMode.SANDBOX,
        hasCredentials: !!row?.credentials,
        // `sandbox` from the adapter reports the PLATFORM's runtime state;
        // `mode` is the tenant's chosen target. Both matter in the UI.
      };
    });

    // AI providers are cross-vertical, so they are not filtered by vertical.
    const aiProviders = AI_PROVIDER_ADAPTERS.map((a) => {
      const row = byCode.get(a.id);
      return {
        ...a,
        kind: 'ai_provider' as const,
        enabled: row?.enabled ?? false,
        hasCredentials: !!row?.credentials,
        // No sandbox concept: an AI provider is either reachable with the
        // tenant's key or it is not. Reporting a sandbox mode here would
        // suggest a safe rehearsal state that does not exist.
      };
    });

    return [...regulators, ...aiProviders];
  }

  /**
   * The tenant's chosen AI provider, decrypted, or null.
   *
   * The only place credentials are decrypted for AI. Returns null rather than
   * throwing when nothing is configured, because "this tenant has not connected
   * a provider" is a normal state that the caller answers by falling back to
   * the platform key.
   */
  async resolveAiProvider(tenantId: string): Promise<ResolvedAiProvider | null> {
    const rows = await this.connectorRepo.find({
      where: { tenantId, enabled: true },
    });

    // Deterministic by catalogue order, not by whatever order Postgres
    // returned. Nothing stops a tenant enabling two providers, and an
    // unordered `find` would then route inference to a different vendor
    // between two identical requests — the same defect that once handed a UAE
    // bank an arbitrary config pack, and just as invisible, because both
    // answers look correct in isolation.
    const byCode = new Map(rows.map((r) => [r.adapterCode, r]));
    const row = AI_PROVIDER_CODES.map((code) => byCode.get(code)).find(
      (r) => r?.credentials,
    );
    if (!row?.credentials) return null;

    const creds = decryptCredentials(row.credentials) as {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    };

    const catalogue = AI_PROVIDER_ADAPTERS.find((a) => a.id === row.adapterCode);

    return {
      adapterCode: row.adapterCode,
      baseUrl: creds.baseUrl ?? catalogue?.defaultBaseUrl ?? null,
      apiKey: creds.apiKey ?? null,
      model: creds.model ?? catalogue?.defaultModel ?? null,
    };
  }

  async upsert(
    tenantId: string,
    vertical: string | null,
    adapterCode: string,
    input: UpsertConnectorInput,
  ): Promise<Omit<TenantConnector, 'credentials'> & { hasCredentials: boolean }> {
    const isAiProvider = AI_PROVIDER_CODES.includes(adapterCode);
    const allowed = (vertical && VERTICAL_ADAPTERS[vertical]) ?? [];

    if (!isAiProvider && !allowed.includes(adapterCode)) {
      throw new BadRequestException(
        `Adapter '${adapterCode}' is not available for the '${vertical}' vertical`,
      );
    }

    const row =
      (await this.connectorRepo.findOne({
        where: { tenantId, adapterCode },
      })) ?? this.connectorRepo.create({ tenantId, adapterCode });

    if (input.enabled !== undefined) row.enabled = input.enabled;
    if (input.mode !== undefined) row.mode = input.mode;
    if (input.credentials === null) row.credentials = null;
    else if (input.credentials !== undefined) {
      row.credentials = encryptCredentials(input.credentials);
    }

    if (isAiProvider) {
      // No sandbox to fall back to: an enabled AI provider with no credentials
      // cannot answer, and the failure would surface later as an opaque
      // upstream error on whatever feature happened to call the gateway first.
      // Refuse it here, where the person who can fix it is looking.
      if (row.enabled && !row.credentials) {
        throw new BadRequestException(
          `AI provider '${adapterCode}' cannot be enabled without credentials`,
        );
      }
      if (row.enabled && adapterCode === 'custom-openai-compatible') {
        const creds = row.credentials
          ? (decryptCredentials(row.credentials) as { baseUrl?: string })
          : {};
        if (!creds.baseUrl) {
          throw new BadRequestException(
            "'custom-openai-compatible' requires a baseUrl — that is the only " +
              'thing telling the gateway where to send requests',
          );
        }
      }
    } else if (
      row.mode === ConnectorMode.LIVE &&
      row.enabled &&
      !row.credentials
    ) {
      throw new BadRequestException(
        'Live mode requires credentials — supply them or stay in sandbox',
      );
    }

    const saved = await this.connectorRepo.save(row);
    const { credentials, ...rest } = saved;
    return { ...rest, hasCredentials: !!credentials };
  }
}
