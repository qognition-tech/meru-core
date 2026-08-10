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

// ── CBUAE API Response Types ──────────────────────────────────────────────

export interface SanctionsScreeningResult {
  entityName: string;
  matchFound: boolean;
  matches: Array<{
    listName: string; // e.g. "UN", "OFAC", "UAE Local Terrorist List"
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
  tradeLicenseNumber?: string;
  status: 'verified' | 'unverified' | 'expired' | 'suspended';
  licenseType?: string;
  issuingAuthority: string;
  expiryDate?: string;
  activities: string[];
  verifiedAt: string;
}

// ── CBUAE Adapter ─────────────────────────────────────────────────────────

@Injectable()
export class UaeCentralBankAdapter implements GovernmentAdapter {
  readonly adapterId = 'uae-central-bank';
  readonly country = 'AE';
  readonly regulatorName = 'Central Bank of the UAE (CBUAE)';

  private readonly logger = new Logger(UaeCentralBankAdapter.name);
  private readonly config: AdapterConfig;
  private readonly sandboxMode: boolean;

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
    const liveRequested = configService.get('CBUAE_SANDBOX') === 'false';
    const credentialsPresent =
      !!configService.get('CBUAE_API_KEY');
    const useSandbox = !(liveRequested && credentialsPresent);

    this.sandboxMode = useSandbox;
    this.config = {
      baseUrl: useSandbox
        ? configService.get(
            'CBUAE_SANDBOX_URL',
            'https://sandbox.api.centralbank.ae/v1',
          )
        : configService.get('CBUAE_BASE_URL', 'https://api.centralbank.ae/v1'),
      authMethod: 'mtls',
      credentials: {
        certificatePath: configService.get('CBUAE_CERT_PATH', ''),
        privateKeyPath: configService.get('CBUAE_KEY_PATH', ''),
        apiKey: configService.get('CBUAE_API_KEY', ''),
      },
      timeoutMs: 30_000,
      rateLimitRpm: 30,
    };
  }

  isSandbox(): boolean {
    return this.sandboxMode;
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
        message: 'Sandbox mode — no live CBUAE calls',
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

  // ── STR/SAR Filing ──────────────────────────────────────────────────────

  async fileSTR(
    filing: STRFilingInput,
  ): Promise<AdapterResponse<STRFilingResult>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxFileSTR(filing, requestId, start);
    }

    try {
      const resp = await fetch(`${this.config.baseUrl}/compliance/str`, {
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

  // ── Entity Verification (Trade License) ──────────────────────────────────

  async verifyEntity(
    tradeLicenseNumber: string,
    entityName?: string,
  ): Promise<AdapterResponse<EntityVerificationResult>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxVerifyEntity(
        tradeLicenseNumber,
        entityName,
        requestId,
        start,
      );
    }

    try {
      const resp = await fetch(
        `${this.config.baseUrl}/verification/trade-license/${encodeURIComponent(tradeLicenseNumber)}`,
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

  // ── Sandbox stubs ───────────────────────────────────────────────────────

  private sandboxScreenEntity(
    entityName: string,
    entityDetails: any,
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
                listName: 'UAE Local Terrorist List',
                matchScore: 87,
                matchedName: entityName,
                matchedId: 'UAE-TL-2024-0042',
                sanctionsType: 'Asset Freeze',
                dateListed: '2024-03-15',
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
        acknowledgementNumber: `CBUAE-ACK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        submittedAt: new Date().toISOString(),
      },
    };
  }

  private sandboxRegulatoryUpdates(
    filters: any,
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
          updateId: 'CBUAE-2026-001',
          circularNumber: '28/2026',
          title:
            'Updated AML/CFT Guidelines for Designated Non-Financial Businesses',
          category: 'aml',
          issuedDate: '2026-05-15',
          effectiveDate: '2026-06-01',
          summary:
            'Revised customer due diligence requirements for DNFBPs including real estate agents and precious metals dealers.',
          fullTextUrl: 'https://centralbank.ae/circulars/28-2026',
          affectedSectors: ['real_estate', 'precious_metals', 'legal'],
          urgency: 'high',
        },
        {
          updateId: 'CBUAE-2026-002',
          circularNumber: '29/2026',
          title: 'New Sanctions Designations — UN Security Council Resolution',
          category: 'sanctions',
          issuedDate: '2026-05-20',
          effectiveDate: '2026-05-20',
          summary:
            'Addition of 12 individuals and 5 entities to the UN sanctions list. Immediate freezing of assets required.',
          fullTextUrl: 'https://centralbank.ae/circulars/29-2026',
          affectedSectors: ['banking', 'financial_services'],
          urgency: 'immediate',
        },
        {
          updateId: 'CBUAE-2026-003',
          circularNumber: '30/2026',
          title: 'Prudential Returns — Revised Reporting Templates for Q2 2026',
          category: 'prudential',
          issuedDate: '2026-05-25',
          effectiveDate: '2026-07-01',
          summary:
            'Updated BRF 1, BRF 2, and BRF 3 reporting templates with enhanced capital adequacy disclosure requirements.',
          affectedSectors: ['banking'],
          urgency: 'medium',
        },
      ],
    };
  }

  private sandboxVerifyEntity(
    tradeLicenseNumber: string,
    entityName: string | undefined,
    requestId: string,
    start: number,
  ): AdapterResponse<EntityVerificationResult> {
    this.logger.debug(`[SANDBOX] verifyEntity: ${tradeLicenseNumber}`);
    return {
      success: true,
      sandbox: true,
      requestId,
      latencyMs: Date.now() - start,
      data: {
        entityName: entityName || 'Al-Mansoori Trading LLC',
        tradeLicenseNumber,
        status: 'verified',
        licenseType: 'Commercial',
        issuingAuthority: 'Department of Economic Development — Dubai',
        expiryDate: '2027-12-31',
        activities: [
          'General Trading',
          'Import & Export',
          'Financial Consulting',
        ],
        verifiedAt: new Date().toISOString(),
      },
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

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
        message: `CBUAE API returned HTTP ${httpStatus}`,
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
    this.logger.error(`CBUAE API network error: ${msg}`);
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
