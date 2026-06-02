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

// ── Public types for UK Home Office / UKVI responses ───────────────────────

export interface VisaStatusResponse {
  visaReference: string;
  route: string; // e.g. "Skilled Worker", "Student", "Global Talent"
  status: 'granted' | 'refused' | 'pending' | 'curtailed' | 'expired';
  grantDate?: string;
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
  ghReference: string; // GWF/UAN reference
  route: string;
  status:
    | 'submitted'
    | 'biometrics_pending'
    | 'under_consideration'
    | 'further_information_requested'
    | 'decision_made'
    | 'completed';
  submittedAt: string;
  lastUpdatedAt: string;
  priorityService?: 'standard' | 'priority' | 'super_priority';
  outstandingRequirements?: string[];
}

export interface SponsorLicenceResponse {
  sponsorName: string;
  licenceNumber: string;
  status: 'active' | 'suspended' | 'revoked' | 'expired';
  tier: string; // e.g. "Worker", "Temporary Worker", "Student"
  rating: 'A' | 'B' | null;
  cosAllocation?: number; // Certificates of Sponsorship allocated
  cosUsed?: number;
  expiryDate?: string;
}

export interface RightToWorkResponse {
  shareCode: string;
  status: 'allowed' | 'not_allowed' | 'expired' | 'not_found';
  workEntitlement?: 'full' | 'restricted' | 'none';
  restrictionDetails?: string;
  checkedAt: string;
  holderName?: string;
}

// ── UK Home Office Adapter ───────────────────────────────────────────────────

@Injectable()
export class UkHomeOfficeAdapter implements GovernmentAdapter {
  readonly adapterId = 'uk-home-office';
  readonly country = 'GB';
  readonly regulatorName = 'UK Visas and Immigration (UKVI)';

  private readonly logger = new Logger(UkHomeOfficeAdapter.name);
  private readonly config: AdapterConfig;
  private readonly sandboxMode: boolean;

  constructor(private readonly configService: ConfigService) {
    const useSandbox =
      configService.get('NODE_ENV') !== 'production' ||
      configService.get('UKVI_SANDBOX') === 'true';

    this.sandboxMode = useSandbox;
    this.config = {
      baseUrl: useSandbox
        ? configService.get('UKVI_SANDBOX_URL', 'https://sandbox.api.homeoffice.gov.uk/v1')
        : configService.get('UKVI_BASE_URL', 'https://api.homeoffice.gov.uk/v1'),
      authMethod: 'oauth2',
      credentials: {
        clientId: configService.get('UKVI_CLIENT_ID', ''),
        clientSecret: configService.get('UKVI_CLIENT_SECRET', ''),
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
      'right_to_work',
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
    visaReference: string,
    passportNumber: string,
  ): Promise<AdapterResponse<VisaStatusResponse>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxVisaStatus(visaReference, passportNumber, requestId, start);
    }

    try {
      const token = await this.getAccessToken();
      const resp = await fetch(
        `${this.config.baseUrl}/visas/${encodeURIComponent(visaReference)}/status`,
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

  async validateSponsor(
    licenceNumber: string,
  ): Promise<AdapterResponse<SponsorLicenceResponse>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxSponsorLicence(licenceNumber, requestId, start);
    }

    try {
      const token = await this.getAccessToken();
      const resp = await fetch(
        `${this.config.baseUrl}/sponsors/${encodeURIComponent(licenceNumber)}`,
        {
          headers: { Authorization: `Bearer ${token}`, 'X-Request-ID': requestId },
          signal: AbortSignal.timeout(this.config.timeoutMs!),
        },
      );

      if (!resp.ok) return this.errorResponse(resp.status, requestId, start);
      const data = (await resp.json()) as SponsorLicenceResponse;
      return { success: true, data, latencyMs: Date.now() - start, requestId, sandbox: false };
    } catch (err: unknown) {
      return this.networkError(err, requestId, start);
    }
  }

  async rightToWorkCheck(
    shareCode: string,
    dateOfBirth: string,
  ): Promise<AdapterResponse<RightToWorkResponse>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxRightToWork(shareCode, requestId, start);
    }

    try {
      const token = await this.getAccessToken();
      const resp = await fetch(`${this.config.baseUrl}/right-to-work/check`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Request-ID': requestId,
        },
        body: JSON.stringify({ shareCode, dateOfBirth }),
        signal: AbortSignal.timeout(this.config.timeoutMs!),
      });

      if (!resp.ok) return this.errorResponse(resp.status, requestId, start);
      const data = (await resp.json()) as RightToWorkResponse;
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
        scope: 'visa.read application.read sponsor.read rtw.check',
      }),
    });

    if (!resp.ok) throw new Error(`OAuth2 token fetch failed: HTTP ${resp.status}`);

    const { access_token, expires_in } = (await resp.json()) as { access_token: string; expires_in: number };
    this.tokenCache = { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
    return access_token;
  }

  // ── Sandbox stubs ─────────────────────────────────────────────────────────

  private sandboxVisaStatus(
    visaReference: string,
    passportNumber: string,
    requestId: string,
    start: number,
  ): AdapterResponse<VisaStatusResponse> {
    this.logger.debug(`[SANDBOX] getVisaStatus: ${visaReference}`);
    return {
      success: true,
      sandbox: true,
      requestId,
      latencyMs: Date.now() - start,
      data: {
        visaReference,
        route: 'Skilled Worker',
        status: 'granted',
        grantDate: '2024-03-01',
        expiryDate: '2027-02-28',
        conditions: ['No recourse to public funds', 'Work only for licensed sponsor'],
        holder: {
          firstName: 'Jane',
          lastName: 'Doe',
          passportNumber,
          nationality: 'IN',
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
        ghReference: `GWF${applicationId.replace(/\D/g, '').slice(0, 9).padStart(9, '0')}`,
        route: 'Skilled Worker',
        status: 'under_consideration',
        submittedAt: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(),
        lastUpdatedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
        priorityService: 'priority',
        outstandingRequirements: [],
      },
    };
  }

  private sandboxSponsorLicence(
    licenceNumber: string,
    requestId: string,
    start: number,
  ): AdapterResponse<SponsorLicenceResponse> {
    this.logger.debug(`[SANDBOX] validateSponsor: ${licenceNumber}`);
    return {
      success: true,
      sandbox: true,
      requestId,
      latencyMs: Date.now() - start,
      data: {
        sponsorName: 'Britannia Tech Ltd',
        licenceNumber,
        status: 'active',
        tier: 'Worker',
        rating: 'A',
        cosAllocation: 20,
        cosUsed: 7,
        expiryDate: '2028-03-31',
      },
    };
  }

  private sandboxRightToWork(
    shareCode: string,
    requestId: string,
    start: number,
  ): AdapterResponse<RightToWorkResponse> {
    this.logger.debug(`[SANDBOX] rightToWorkCheck: ${shareCode}`);
    return {
      success: true,
      sandbox: true,
      requestId,
      latencyMs: Date.now() - start,
      data: {
        shareCode,
        status: 'allowed',
        workEntitlement: 'full',
        checkedAt: new Date().toISOString(),
        holderName: 'Jane Doe',
      },
    };
  }

  // ── Error helpers ─────────────────────────────────────────────────────────

  private errorResponse<T = unknown>(httpStatus: number, requestId: string, start: number): AdapterResponse<T> {
    return {
      success: false,
      error: { code: `HTTP_${httpStatus}`, message: `UKVI API returned HTTP ${httpStatus}`, retryable: httpStatus >= 500 },
      latencyMs: Date.now() - start,
      requestId,
      sandbox: this.sandboxMode,
    };
  }

  private networkError<T = unknown>(err: unknown, requestId: string, start: number): AdapterResponse<T> {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.error(`UKVI API network error: ${msg}`);
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
