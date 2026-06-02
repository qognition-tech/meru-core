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

// ── Public types for IRCC responses ───────────────────────────────────────
// Immigration, Refugees and Citizenship Canada.

export interface VisaStatusResponse {
  documentNumber: string;
  documentType: 'visitor_visa' | 'study_permit' | 'work_permit' | 'eta' | 'permanent_resident';
  status: 'approved' | 'refused' | 'in_process' | 'expired' | 'revoked';
  issueDate?: string;
  expiryDate?: string;
  conditions: string[];
  holder: {
    firstName: string;
    lastName: string;
    passportNumber: string;
    nationality: string;
  };
}

export interface ApplicationStatusResponse {
  applicationId: string;
  uci?: string; // Unique Client Identifier
  applicationType: string; // e.g. "Express Entry", "Study Permit", "PGWP"
  status:
    | 'submitted'
    | 'in_review'
    | 'additional_documents_requested'
    | 'background_check'
    | 'decision_made'
    | 'completed';
  submittedAt: string;
  lastUpdatedAt: string;
  estimatedDecisionDate?: string;
  outstandingRequirements?: string[];
}

export interface EmployerComplianceResponse {
  employerName: string;
  businessNumber: string; // CRA BN
  lmiaStatus: 'approved' | 'pending' | 'refused' | 'not_required' | 'expired';
  complianceStatus: 'compliant' | 'under_review' | 'non_compliant';
  approvedPositions?: number;
  positionsFilled?: number;
  expiryDate?: string;
}

// ── IRCC Adapter ─────────────────────────────────────────────────────────────

@Injectable()
export class CaIrccAdapter implements GovernmentAdapter {
  readonly adapterId = 'ca-ircc';
  readonly country = 'CA';
  readonly regulatorName = 'Immigration, Refugees and Citizenship Canada (IRCC)';

  private readonly logger = new Logger(CaIrccAdapter.name);
  private readonly config: AdapterConfig;
  private readonly sandboxMode: boolean;

  constructor(private readonly configService: ConfigService) {
    const useSandbox =
      configService.get('NODE_ENV') !== 'production' ||
      configService.get('IRCC_SANDBOX') === 'true';

    this.sandboxMode = useSandbox;
    this.config = {
      baseUrl: useSandbox
        ? configService.get('IRCC_SANDBOX_URL', 'https://sandbox.api.cic.gc.ca/v1')
        : configService.get('IRCC_BASE_URL', 'https://api.cic.gc.ca/v1'),
      authMethod: 'oauth2',
      credentials: {
        clientId: configService.get('IRCC_CLIENT_ID', ''),
        clientSecret: configService.get('IRCC_CLIENT_SECRET', ''),
      },
      timeoutMs: 30_000,
      rateLimitRpm: 60,
    };
  }

  isSandbox(): boolean {
    return this.sandboxMode;
  }

  supportsCapability(capability: AdapterCapability): boolean {
    return [
      'visa_status',
      'application_status',
      'sponsor_validation',
      'lodge_application',
    ].includes(capability);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();

    if (this.sandboxMode) {
      return {
        status: 'healthy',
        latencyMs: Date.now() - start,
        lastCheckedAt: new Date(),
        message: 'Sandbox mode — no live API calls',
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
      return { status: 'down', latencyMs: Date.now() - start, lastCheckedAt: new Date(), message: msg };
    }
  }

  // ── Capabilities ─────────────────────────────────────────────────────────

  async getVisaStatus(
    documentNumber: string,
    passportNumber: string,
  ): Promise<AdapterResponse<VisaStatusResponse>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxVisaStatus(documentNumber, passportNumber, requestId, start);
    }

    try {
      const token = await this.getAccessToken();
      const resp = await fetch(
        `${this.config.baseUrl}/documents/${encodeURIComponent(documentNumber)}/status`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Passport-Number': passportNumber,
            'X-Request-ID': requestId,
          },
          signal: AbortSignal.timeout(this.config.timeoutMs!),
        },
      );

      if (!resp.ok) return this.errorResponse(resp.status, requestId, start);
      const data = (await resp.json()) as VisaStatusResponse;
      return { success: true, data, latencyMs: Date.now() - start, requestId, sandbox: false };
    } catch (err: unknown) {
      return this.networkError(err, requestId, start);
    }
  }

  async getApplicationStatus(
    applicationId: string,
  ): Promise<AdapterResponse<ApplicationStatusResponse>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxApplicationStatus(applicationId, requestId, start);
    }

    try {
      const token = await this.getAccessToken();
      const resp = await fetch(
        `${this.config.baseUrl}/applications/${encodeURIComponent(applicationId)}`,
        {
          headers: { Authorization: `Bearer ${token}`, 'X-Request-ID': requestId },
          signal: AbortSignal.timeout(this.config.timeoutMs!),
        },
      );

      if (!resp.ok) return this.errorResponse(resp.status, requestId, start);
      const data = (await resp.json()) as ApplicationStatusResponse;
      return { success: true, data, latencyMs: Date.now() - start, requestId, sandbox: false };
    } catch (err: unknown) {
      return this.networkError(err, requestId, start);
    }
  }

  async validateEmployer(
    businessNumber: string,
  ): Promise<AdapterResponse<EmployerComplianceResponse>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxEmployerCompliance(businessNumber, requestId, start);
    }

    try {
      const token = await this.getAccessToken();
      const resp = await fetch(
        `${this.config.baseUrl}/employers/validate?businessNumber=${encodeURIComponent(businessNumber)}`,
        {
          headers: { Authorization: `Bearer ${token}`, 'X-Request-ID': requestId },
          signal: AbortSignal.timeout(this.config.timeoutMs!),
        },
      );

      if (!resp.ok) return this.errorResponse(resp.status, requestId, start);
      const data = (await resp.json()) as EmployerComplianceResponse;
      return { success: true, data, latencyMs: Date.now() - start, requestId, sandbox: false };
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
        scope: 'document.read application.read employer.read',
      }),
    });

    if (!resp.ok) throw new Error(`OAuth2 token fetch failed: HTTP ${resp.status}`);

    const { access_token, expires_in } = (await resp.json()) as { access_token: string; expires_in: number };
    this.tokenCache = { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
    return access_token;
  }

  // ── Sandbox stubs ─────────────────────────────────────────────────────────

  private sandboxVisaStatus(
    documentNumber: string,
    passportNumber: string,
    requestId: string,
    start: number,
  ): AdapterResponse<VisaStatusResponse> {
    this.logger.debug(`[SANDBOX] getVisaStatus: ${documentNumber}`);
    return {
      success: true,
      sandbox: true,
      requestId,
      latencyMs: Date.now() - start,
      data: {
        documentNumber,
        documentType: 'work_permit',
        status: 'approved',
        issueDate: '2024-02-01',
        expiryDate: '2027-01-31',
        conditions: ['Employer-specific', 'No work in childcare/health without medical'],
        holder: {
          firstName: 'Jane',
          lastName: 'Doe',
          passportNumber,
          nationality: 'GB',
        },
      },
    };
  }

  private sandboxApplicationStatus(
    applicationId: string,
    requestId: string,
    start: number,
  ): AdapterResponse<ApplicationStatusResponse> {
    this.logger.debug(`[SANDBOX] getApplicationStatus: ${applicationId}`);
    return {
      success: true,
      sandbox: true,
      requestId,
      latencyMs: Date.now() - start,
      data: {
        applicationId,
        uci: `${1000000000 + (parseInt(applicationId.replace(/\D/g, '').slice(0, 4) || '0', 10) || 0)}`,
        applicationType: 'Express Entry — Federal Skilled Worker',
        status: 'background_check',
        submittedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
        lastUpdatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        estimatedDecisionDate: new Date(Date.now() + 50 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        outstandingRequirements: [],
      },
    };
  }

  private sandboxEmployerCompliance(
    businessNumber: string,
    requestId: string,
    start: number,
  ): AdapterResponse<EmployerComplianceResponse> {
    this.logger.debug(`[SANDBOX] validateEmployer: ${businessNumber}`);
    return {
      success: true,
      sandbox: true,
      requestId,
      latencyMs: Date.now() - start,
      data: {
        employerName: 'Maple Tech Solutions Inc.',
        businessNumber,
        lmiaStatus: 'approved',
        complianceStatus: 'compliant',
        approvedPositions: 8,
        positionsFilled: 5,
        expiryDate: '2027-05-31',
      },
    };
  }

  // ── Error helpers ─────────────────────────────────────────────────────────

  private errorResponse<T = unknown>(httpStatus: number, requestId: string, start: number): AdapterResponse<T> {
    return {
      success: false,
      error: { code: `HTTP_${httpStatus}`, message: `IRCC API returned HTTP ${httpStatus}`, retryable: httpStatus >= 500 },
      latencyMs: Date.now() - start,
      requestId,
      sandbox: this.sandboxMode,
    };
  }

  private networkError<T = unknown>(err: unknown, requestId: string, start: number): AdapterResponse<T> {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.error(`IRCC API network error: ${msg}`);
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
