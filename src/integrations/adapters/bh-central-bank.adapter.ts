import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import type {
  GovernmentAdapter,
  AdapterCapability,
  AdapterConfig,
  AdapterResponse,
  HealthCheckResult,
} from '../interfaces/government-adapter.interface';

// ── CBB API Response Types ─────────────────────────────────────────────────
// Central Bank of Bahrain (CBB) + Bahrain Financial Intelligence Unit.

export interface SanctionsScreeningResult {
  entityName: string;
  matchFound: boolean;
  matches: Array<{
    listName: string; // e.g. "UN", "OFAC", "Bahrain Terrorist List"
    matchScore: number; // 0-100
    matchedName: string;
    matchedId?: string;
    sanctionsType: string;
    dateListed?: string;
  }>;
  screenedAt: string;
}

export interface RegulatoryUpdate {
  updateId: string;
  circularNumber: string;
  title: string;
  category: 'aml' | 'cft' | 'sanctions' | 'prudential' | 'conduct' | 'other';
  issuedDate: string;
  effectiveDate?: string;
  summary: string;
  fullTextUrl?: string;
  affectedSectors: string[];
  urgency: 'immediate' | 'high' | 'medium' | 'low';
}

export interface STRFilingInput {
  reportingEntityId: string;
  subjectName: string;
  subjectIdNumber?: string;
  transactionDetails: string;
  suspicionReason: string;
  amount?: number;
  currency?: string;
  transactionDate?: string;
}

export interface STRFilingResult {
  filingId: string;
  status:
    | 'submitted'
    | 'acknowledged'
    | 'under_review'
    | 'accepted'
    | 'rejected';
  acknowledgementNumber?: string;
  submittedAt: string;
  reviewedAt?: string;
  notes?: string;
}

export interface EntityVerificationResult {
  entityName: string;
  commercialRegistrationNumber?: string;
  status: 'verified' | 'unverified' | 'expired' | 'suspended';
  licenseType?: string;
  issuingAuthority: string;
  expiryDate?: string;
  activities: string[];
  verifiedAt: string;
}

// ── CBB Adapter ─────────────────────────────────────────────────────────────

@Injectable()
export class BhCentralBankAdapter implements GovernmentAdapter {
  readonly adapterId = 'bh-central-bank';
  readonly country = 'BH';
  readonly regulatorName = 'Central Bank of Bahrain (CBB)';

  private readonly logger = new Logger(BhCentralBankAdapter.name);
  private readonly config: AdapterConfig;
  private readonly sandboxMode: boolean;
  private readonly credentialsConfigured: boolean;

  constructor(private readonly configService: ConfigService) {
    // Sandbox unless BOTH a deliberate opt-in to live AND real credentials are
    // present. The previous rule was `NODE_ENV !== 'production' || <FLAG>`,
    // which inverts the safe default exactly where it matters: on production,
    // with no credentials configured and no licence held, the adapter declared
    // itself LIVE. Every call then went to the real regulator host and failed —
    // and, worse, `isSandbox()` reported false, so `provenance.sandbox` would
    // have told the UI that a stub-free 503 came from a live regulator. A
    // missing credential can only ever mean "not licensed yet", never
    // "go live".
    const liveRequested = configService.get('CBB_SANDBOX') === 'false';
    const credentialsPresent =
      !!configService.get('CBB_CLIENT_ID') &&
      !!configService.get('CBB_CLIENT_SECRET');
    const useSandbox = !(liveRequested && credentialsPresent);

    this.sandboxMode = useSandbox;
    this.credentialsConfigured = credentialsPresent;
    this.config = {
      baseUrl: useSandbox
        ? configService.get(
            'CBB_SANDBOX_URL',
            'https://sandbox.api.cbb.gov.bh/v1',
          )
        : configService.get('CBB_BASE_URL', 'https://api.cbb.gov.bh/v1'),
      authMethod: 'oauth2',
      credentials: {
        clientId: configService.get('CBB_CLIENT_ID', ''),
        clientSecret: configService.get('CBB_CLIENT_SECRET', ''),
        apiKey: configService.get('CBB_API_KEY', ''),
      },
      timeoutMs: 30_000,
      rateLimitRpm: 30,
    };
  }

  isSandbox(): boolean {
    return this.sandboxMode;
  }

  /** Whether a live credential pair is configured — independent of whether live mode was requested. */
  hasCredentials(): boolean {
    return this.credentialsConfigured;
  }

  supportsCapability(capability: AdapterCapability): boolean {
    return [
      'screening',
      'sar_filing',
      'document_verification',
      'identity_verification',
    ].includes(capability);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    if (this.sandboxMode) {
      return {
        status: 'healthy',
        latencyMs: Date.now() - start,
        lastCheckedAt: new Date(),
        message: 'Sandbox mode — no live CBB calls',
      };
    }

    try {
      const resp = await fetch(`${this.config.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return {
        status: resp.ok ? 'healthy' : 'degraded',
        latencyMs: Date.now() - start,
        lastCheckedAt: new Date(),
        message: resp.ok ? undefined : `HTTP ${resp.status}`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'down',
        latencyMs: Date.now() - start,
        lastCheckedAt: new Date(),
        message: msg,
      };
    }
  }

  // ── Sanctions Screening ──────────────────────────────────────────────────

  async screenEntity(
    entityName: string,
    entityDetails?: {
      nationality?: string;
      idNumber?: string;
      entityType?: string;
    },
  ): Promise<AdapterResponse<SanctionsScreeningResult>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxScreenEntity(
        entityName,
        entityDetails,
        requestId,
        start,
      );
    }

    try {
      const resp = await fetch(`${this.config.baseUrl}/screening/sanctions`, {
        method: 'POST',
        headers: this.authHeaders(requestId),
        body: JSON.stringify({ entityName, ...entityDetails }),
        signal: AbortSignal.timeout(this.config.timeoutMs!),
      });

      if (!resp.ok) return this.errorResponse(resp.status, requestId, start);
      const data = (await resp.json()) as SanctionsScreeningResult;
      return {
        success: true,
        data,
        latencyMs: Date.now() - start,
        requestId,
        sandbox: false,
      };
    } catch (err: unknown) {
      return this.networkError(err, requestId, start);
    }
  }

  // ── STR Filing ──────────────────────────────────────────────────────────

  async fileSTR(
    filing: STRFilingInput,
  ): Promise<AdapterResponse<STRFilingResult>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxFileSTR(filing, requestId, start);
    }

    try {
      const resp = await fetch(`${this.config.baseUrl}/fiu/str`, {
        method: 'POST',
        headers: this.authHeaders(requestId),
        body: JSON.stringify(filing),
        signal: AbortSignal.timeout(this.config.timeoutMs!),
      });

      if (!resp.ok) return this.errorResponse(resp.status, requestId, start);
      const data = (await resp.json()) as STRFilingResult;
      return {
        success: true,
        data,
        latencyMs: Date.now() - start,
        requestId,
        sandbox: false,
      };
    } catch (err: unknown) {
      return this.networkError(err, requestId, start);
    }
  }

  // ── Regulatory Updates ───────────────────────────────────────────────────

  async getRegulatoryUpdates(filters?: {
    category?: string;
    since?: string;
    limit?: number;
  }): Promise<AdapterResponse<RegulatoryUpdate[]>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxRegulatoryUpdates(filters, requestId, start);
    }

    try {
      const params = new URLSearchParams();
      if (filters?.category) params.set('category', filters.category);
      if (filters?.since) params.set('since', filters.since);
      if (filters?.limit) params.set('limit', String(filters.limit));

      const resp = await fetch(
        `${this.config.baseUrl}/regulatory/circulars?${params}`,
        {
          headers: this.authHeaders(requestId),
          signal: AbortSignal.timeout(this.config.timeoutMs!),
        },
      );

      if (!resp.ok) return this.errorResponse(resp.status, requestId, start);
      const data = (await resp.json()) as RegulatoryUpdate[];
      return {
        success: true,
        data,
        latencyMs: Date.now() - start,
        requestId,
        sandbox: false,
      };
    } catch (err: unknown) {
      return this.networkError(err, requestId, start);
    }
  }

  // ── Entity Verification (Commercial Registration / Sijilat) ────────────────

  async verifyEntity(
    commercialRegistrationNumber: string,
    entityName?: string,
  ): Promise<AdapterResponse<EntityVerificationResult>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxVerifyEntity(
        commercialRegistrationNumber,
        entityName,
        requestId,
        start,
      );
    }

    try {
      const resp = await fetch(
        `${this.config.baseUrl}/verification/commercial-registration/${encodeURIComponent(commercialRegistrationNumber)}`,
        {
          headers: this.authHeaders(requestId),
          signal: AbortSignal.timeout(this.config.timeoutMs!),
        },
      );

      if (!resp.ok) return this.errorResponse(resp.status, requestId, start);
      const data = (await resp.json()) as EntityVerificationResult;
      return {
        success: true,
        data,
        latencyMs: Date.now() - start,
        requestId,
        sandbox: false,
      };
    } catch (err: unknown) {
      return this.networkError(err, requestId, start);
    }
  }

  // ── OAuth2 token management ──────────────────────────────────────────────

  private tokenCache: { token: string; expiresAt: number } | null = null;

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 60_000) {
      return this.tokenCache.token;
    }

    const { clientId, clientSecret } = this.config.credentials!;
    const resp = await fetch(`${this.config.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'screening.read fiu.write regulatory.read verification.read',
      }),
    });

    if (!resp.ok)
      throw new Error(`OAuth2 token fetch failed: HTTP ${resp.status}`);

    const { access_token, expires_in } = (await resp.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.tokenCache = {
      token: access_token,
      expiresAt: Date.now() + expires_in * 1000,
    };
    return access_token;
  }

  // ── Sandbox stubs ───────────────────────────────────────────────────────

  private sandboxScreenEntity(
    entityName: string,
    _entityDetails: any,
    requestId: string,
    start: number,
  ): AdapterResponse<SanctionsScreeningResult> {
    this.logger.debug(`[SANDBOX] screenEntity: ${entityName}`);
    const lowRisk =
      entityName.toLowerCase().includes('acme') ||
      entityName.toLowerCase().includes('global');
    return {
      success: true,
      sandbox: true,
      requestId,
      latencyMs: Date.now() - start,
      data: {
        entityName,
        matchFound: !lowRisk,
        matches: lowRisk
          ? []
          : [
              {
                listName: 'Bahrain Terrorist List',
                matchScore: 81,
                matchedName: entityName,
                matchedId: 'BH-TL-2024-0019',
                sanctionsType: 'Asset Freeze',
                dateListed: '2024-01-30',
              },
            ],
        screenedAt: new Date().toISOString(),
      },
    };
  }

  private sandboxFileSTR(
    filing: STRFilingInput,
    requestId: string,
    start: number,
  ): AdapterResponse<STRFilingResult> {
    this.logger.debug(`[SANDBOX] fileSTR: ${filing.subjectName}`);
    return {
      success: true,
      sandbox: true,
      requestId,
      latencyMs: Date.now() - start,
      data: {
        filingId: `STR-${Date.now()}`,
        status: 'acknowledged',
        acknowledgementNumber: `BHFIU-ACK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        submittedAt: new Date().toISOString(),
      },
    };
  }

  private sandboxRegulatoryUpdates(
    _filters: any,
    requestId: string,
    start: number,
  ): AdapterResponse<RegulatoryUpdate[]> {
    this.logger.debug('[SANDBOX] getRegulatoryUpdates');
    return {
      success: true,
      sandbox: true,
      requestId,
      latencyMs: Date.now() - start,
      data: [
        {
          updateId: 'CBB-2026-001',
          circularNumber: 'OG/123/2026',
          title: 'Financial Crime Module (FC) Amendments',
          category: 'aml',
          issuedDate: '2026-05-08',
          effectiveDate: '2026-07-01',
          summary:
            'Amendments to the FC Module of the CBB Rulebook covering enhanced due diligence for high-risk customers.',
          fullTextUrl: 'https://cbb.gov.bh/rulebook/fc-123-2026',
          affectedSectors: ['conventional_banks', 'islamic_banks'],
          urgency: 'high',
        },
        {
          updateId: 'CBB-2026-002',
          circularNumber: 'OG/124/2026',
          title: 'UN Security Council Sanctions — Implementation Notice',
          category: 'sanctions',
          issuedDate: '2026-05-19',
          effectiveDate: '2026-05-19',
          summary:
            'Licensees must immediately freeze assets of newly listed persons and entities.',
          fullTextUrl: 'https://cbb.gov.bh/rulebook/fc-124-2026',
          affectedSectors: ['banking', 'financial_services'],
          urgency: 'immediate',
        },
      ],
    };
  }

  private sandboxVerifyEntity(
    commercialRegistrationNumber: string,
    entityName: string | undefined,
    requestId: string,
    start: number,
  ): AdapterResponse<EntityVerificationResult> {
    this.logger.debug(
      `[SANDBOX] verifyEntity: ${commercialRegistrationNumber}`,
    );
    return {
      success: true,
      sandbox: true,
      requestId,
      latencyMs: Date.now() - start,
      data: {
        entityName: entityName || 'Manama Investment & Trading Co. WLL',
        commercialRegistrationNumber,
        status: 'verified',
        licenseType: 'Commercial',
        issuingAuthority:
          'Ministry of Industry and Commerce (Sijilat) — Manama',
        expiryDate: '2027-09-30',
        activities: ['General Trading', 'Investment', 'Financial Advisory'],
        verifiedAt: new Date().toISOString(),
      },
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private authHeaders(requestId: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.config.credentials?.apiKey || '',
      'X-Request-ID': requestId,
    };
  }

  private errorResponse<T = unknown>(
    httpStatus: number,
    requestId: string,
    start: number,
  ): AdapterResponse<T> {
    return {
      success: false,
      error: {
        code: `HTTP_${httpStatus}`,
        message: `CBB API returned HTTP ${httpStatus}`,
        retryable: httpStatus >= 500,
      },
      latencyMs: Date.now() - start,
      requestId,
      sandbox: this.sandboxMode,
    };
  }

  private networkError<T = unknown>(
    err: unknown,
    requestId: string,
    start: number,
  ): AdapterResponse<T> {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.error(`CBB API network error: ${msg}`);
    return {
      success: false,
      error: { code: 'NETWORK_ERROR', message: msg, retryable: true },
      latencyMs: Date.now() - start,
      requestId,
      sandbox: this.sandboxMode,
    };
  }

  private makeRequestId(): string {
    return crypto.randomUUID();
  }
}
