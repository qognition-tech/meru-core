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

// ── Public types for Immigration New Zealand (INZ) responses ───────────────

export interface VisaStatusResponse {
  visaNumber: string;
  visaType: string; // e.g. "Accredited Employer Work Visa", "Student Visa", "Resident Visa"
  status: 'approved' | 'declined' | 'in_progress' | 'expired' | 'cancelled';
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
  inzReference: string;
  visaType: string;
  status:
    | 'received'
    | 'assessment'
    | 'further_information_requested'
    | 'decision_made'
    | 'completed';
  submittedAt: string;
  lastUpdatedAt: string;
  estimatedDecisionDate?: string;
  outstandingRequirements?: string[];
}

export interface AccreditedEmployerResponse {
  employerName: string;
  nzbn: string; // New Zealand Business Number
  accreditationStatus:
    | 'accredited'
    | 'pending'
    | 'declined'
    | 'revoked'
    | 'expired';
  accreditationType?:
    | 'standard'
    | 'high_volume'
    | 'triangular'
    | 'controlling_third_party';
  jobTokenAllocation?: number;
  jobTokensUsed?: number;
  expiryDate?: string;
}

export interface VisaViewResponse {
  visaNumber: string;
  status: 'valid' | 'invalid' | 'not_found';
  visaType?: string;
  conditions?: string[];
  workEntitlement?: 'full' | 'restricted' | 'none';
  studyEntitlement?: boolean;
  checkedAt: string;
}

// ── INZ Adapter ─────────────────────────────────────────────────────────────

@Injectable()
export class NzImmigrationAdapter implements GovernmentAdapter {
  readonly adapterId = 'nz-immigration';
  readonly country = 'NZ';
  readonly regulatorName = 'Immigration New Zealand (INZ)';

  private readonly logger = new Logger(NzImmigrationAdapter.name);
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
    const liveRequested = configService.get('INZ_SANDBOX') === 'false';
    const credentialsPresent =
      !!configService.get('INZ_CLIENT_ID') &&
      !!configService.get('INZ_CLIENT_SECRET');
    const useSandbox = !(liveRequested && credentialsPresent);

    this.sandboxMode = useSandbox;
    this.credentialsConfigured = credentialsPresent;
    this.config = {
      baseUrl: useSandbox
        ? configService.get(
            'INZ_SANDBOX_URL',
            'https://sandbox.api.immigration.govt.nz/v1',
          )
        : configService.get(
            'INZ_BASE_URL',
            'https://api.immigration.govt.nz/v1',
          ),
      authMethod: 'oauth2',
      credentials: {
        clientId: configService.get('INZ_CLIENT_ID', ''),
        clientSecret: configService.get('INZ_CLIENT_SECRET', ''),
      },
      timeoutMs: 30_000,
      rateLimitRpm: 60,
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
      'visa_status',
      'application_status',
      'sponsor_validation',
      'lodge_application',
      'visa_view',
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
      return {
        status: 'down',
        latencyMs: Date.now() - start,
        lastCheckedAt: new Date(),
        message: msg,
      };
    }
  }

  // ── Capabilities ─────────────────────────────────────────────────────────

  async getVisaStatus(
    visaNumber: string,
    passportNumber: string,
  ): Promise<AdapterResponse<VisaStatusResponse>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxVisaStatus(
        visaNumber,
        passportNumber,
        requestId,
        start,
      );
    }

    try {
      const token = await this.getAccessToken();
      const resp = await fetch(
        `${this.config.baseUrl}/visas/${encodeURIComponent(visaNumber)}/status`,
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
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Request-ID': requestId,
          },
          signal: AbortSignal.timeout(this.config.timeoutMs!),
        },
      );

      if (!resp.ok) return this.errorResponse(resp.status, requestId, start);
      const data = (await resp.json()) as ApplicationStatusResponse;
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

  async validateEmployer(
    nzbn: string,
  ): Promise<AdapterResponse<AccreditedEmployerResponse>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxAccreditedEmployer(nzbn, requestId, start);
    }

    try {
      const token = await this.getAccessToken();
      const resp = await fetch(
        `${this.config.baseUrl}/employers/accreditation?nzbn=${encodeURIComponent(nzbn)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Request-ID': requestId,
          },
          signal: AbortSignal.timeout(this.config.timeoutMs!),
        },
      );

      if (!resp.ok) return this.errorResponse(resp.status, requestId, start);
      const data = (await resp.json()) as AccreditedEmployerResponse;
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

  async visaViewCheck(
    visaNumber: string,
    dateOfBirth: string,
  ): Promise<AdapterResponse<VisaViewResponse>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxVisaView(visaNumber, requestId, start);
    }

    try {
      const token = await this.getAccessToken();
      const resp = await fetch(`${this.config.baseUrl}/visaview/check`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Request-ID': requestId,
        },
        body: JSON.stringify({ visaNumber, dateOfBirth }),
        signal: AbortSignal.timeout(this.config.timeoutMs!),
      });

      if (!resp.ok) return this.errorResponse(resp.status, requestId, start);
      const data = (await resp.json()) as VisaViewResponse;
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
        scope: 'visa.read application.read employer.read visaview.check',
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

  // ── Sandbox stubs ─────────────────────────────────────────────────────────

  private sandboxVisaStatus(
    visaNumber: string,
    passportNumber: string,
    requestId: string,
    start: number,
  ): AdapterResponse<VisaStatusResponse> {
    this.logger.debug(`[SANDBOX] getVisaStatus: ${visaNumber}`);
    return {
      success: true,
      sandbox: true,
      requestId,
      latencyMs: Date.now() - start,
      data: {
        visaNumber,
        visaType: 'Accredited Employer Work Visa',
        status: 'approved',
        issueDate: '2024-04-10',
        expiryDate: '2027-04-09',
        conditions: [
          'Work only for accredited employer',
          'Role: Software Engineer',
        ],
        holder: {
          firstName: 'Jane',
          lastName: 'Doe',
          passportNumber,
          nationality: 'PH',
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
        inzReference: `INZ${applicationId.replace(/\D/g, '').slice(0, 8).padStart(8, '0')}`,
        visaType: 'Accredited Employer Work Visa',
        status: 'assessment',
        submittedAt: new Date(
          Date.now() - 20 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        lastUpdatedAt: new Date(
          Date.now() - 2 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        estimatedDecisionDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        outstandingRequirements: [],
      },
    };
  }

  private sandboxAccreditedEmployer(
    nzbn: string,
    requestId: string,
    start: number,
  ): AdapterResponse<AccreditedEmployerResponse> {
    this.logger.debug(`[SANDBOX] validateEmployer: ${nzbn}`);
    return {
      success: true,
      sandbox: true,
      requestId,
      latencyMs: Date.now() - start,
      data: {
        employerName: 'Kiwi Cloud Systems Ltd',
        nzbn,
        accreditationStatus: 'accredited',
        accreditationType: 'standard',
        jobTokenAllocation: 5,
        jobTokensUsed: 2,
        expiryDate: '2027-04-30',
      },
    };
  }

  private sandboxVisaView(
    visaNumber: string,
    requestId: string,
    start: number,
  ): AdapterResponse<VisaViewResponse> {
    this.logger.debug(`[SANDBOX] visaViewCheck: ${visaNumber}`);
    return {
      success: true,
      sandbox: true,
      requestId,
      latencyMs: Date.now() - start,
      data: {
        visaNumber,
        status: 'valid',
        visaType: 'Accredited Employer Work Visa',
        conditions: ['Work only for accredited employer'],
        workEntitlement: 'full',
        studyEntitlement: false,
        checkedAt: new Date().toISOString(),
      },
    };
  }

  // ── Error helpers ─────────────────────────────────────────────────────────

  private errorResponse<T = unknown>(
    httpStatus: number,
    requestId: string,
    start: number,
  ): AdapterResponse<T> {
    return {
      success: false,
      error: {
        code: `HTTP_${httpStatus}`,
        message: `INZ API returned HTTP ${httpStatus}`,
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
    this.logger.error(`INZ API network error: ${msg}`);
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
