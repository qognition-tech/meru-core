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

// ── Public types for AU HomeAffairs responses ────────────────────────────

export interface VisaStatusResponse {
  visaNumber: string;
  subclass: string;
  status: 'granted' | 'refused' | 'pending' | 'cancelled' | 'expired';
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
  referenceNumber: string;
  subclass: string;
  stream?: string;
  status:
    | 'received'
    | 'under_assessment'
    | 'further_information_requested'
    | 'decision_made'
    | 'finalised';
  lodgedAt: string;
  lastUpdatedAt: string;
  estimatedDecisionDate?: string;
  outstandingRequirements?: string[];
}

export interface SponsorValidationResponse {
  abn: string;
  businessName: string;
  sponsorStatus: 'approved' | 'pending' | 'refused' | 'cancelled' | 'lapsed';
  approvedOccupations?: string[];
  nominationQuota?: number;
  nominationsUsed?: number;
  expiryDate?: string;
}

export interface VevoCheckResponse {
  visaNumber: string;
  status: 'valid' | 'invalid' | 'not_found';
  subclass?: string;
  conditions?: string[];
  workEntitlement?: 'full' | 'restricted' | 'none';
  studyEntitlement?: boolean;
  lastCheckedAt: string;
}

// ── AU HomeAffairs Adapter ────────────────────────────────────────────────

@Injectable()
export class AuHomeAffairsAdapter implements GovernmentAdapter {
  readonly adapterId = 'au-home-affairs';
  readonly country = 'AU';
  readonly regulatorName = 'Department of Home Affairs';

  private readonly logger = new Logger(AuHomeAffairsAdapter.name);
  private readonly config: AdapterConfig;

  // When SANDBOX_MODE=true (or no real credentials), adapter returns
  // realistic stub responses rather than hitting the live API.
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
    const liveRequested = configService.get('AU_HOMEAFFAIRS_SANDBOX') === 'false';
    const credentialsPresent =
      !!configService.get('AU_HOMEAFFAIRS_CLIENT_ID') &&
      !!configService.get('AU_HOMEAFFAIRS_CLIENT_SECRET');
    const useSandbox = !(liveRequested && credentialsPresent);

    this.sandboxMode = useSandbox;
    this.config = {
      baseUrl: useSandbox
        ? configService.get(
            'AU_HOMEAFFAIRS_SANDBOX_URL',
            'https://sandbox.immi.homeaffairs.gov.au/api',
          )
        : configService.get(
            'AU_HOMEAFFAIRS_BASE_URL',
            'https://immi.homeaffairs.gov.au/api',
          ),
      authMethod: 'oauth2',
      credentials: {
        clientId: configService.get('AU_HOMEAFFAIRS_CLIENT_ID', ''),
        clientSecret: configService.get('AU_HOMEAFFAIRS_CLIENT_SECRET', ''),
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
      'vevo_check',
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
      // In production: ping the DHA health endpoint
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

      if (!resp.ok) {
        return this.errorResponse(resp.status, requestId, start);
      }

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

  async validateSponsor(
    abn: string,
  ): Promise<AdapterResponse<SponsorValidationResponse>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxSponsorValidation(abn, requestId, start);
    }

    try {
      const token = await this.getAccessToken();
      const resp = await fetch(
        `${this.config.baseUrl}/sponsors/validate?abn=${encodeURIComponent(abn)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Request-ID': requestId,
          },
          signal: AbortSignal.timeout(this.config.timeoutMs!),
        },
      );

      if (!resp.ok) return this.errorResponse(resp.status, requestId, start);
      const data = (await resp.json()) as SponsorValidationResponse;
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

  async vevoCheck(
    visaNumber: string,
    dateOfBirth: string,
  ): Promise<AdapterResponse<VevoCheckResponse>> {
    const requestId = this.makeRequestId();
    const start = Date.now();

    if (this.sandboxMode) {
      return this.sandboxVevoCheck(visaNumber, requestId, start);
    }

    try {
      const token = await this.getAccessToken();
      const resp = await fetch(`${this.config.baseUrl}/vevo/check`, {
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
      const data = (await resp.json()) as VevoCheckResponse;
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
        scope: 'visa.read application.read sponsor.read vevo.check',
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
  // Realistic shapes derived from DHA API documentation.

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
        subclass: '482',
        status: 'granted',
        grantDate: '2024-01-15',
        expiryDate: '2027-01-14',
        conditions: ['8107', '8501', '8502'],
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
        referenceNumber: `REF-${applicationId.slice(0, 8).toUpperCase()}`,
        subclass: '482',
        stream: 'short-term',
        status: 'under_assessment',
        lodgedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
        lastUpdatedAt: new Date(
          Date.now() - 2 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        estimatedDecisionDate: new Date(Date.now() + 75 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        outstandingRequirements: [],
      },
    };
  }

  private sandboxSponsorValidation(
    abn: string,
    requestId: string,
    start: number,
  ): AdapterResponse<SponsorValidationResponse> {
    this.logger.debug(`[SANDBOX] validateSponsor: ${abn}`);
    return {
      success: true,
      sandbox: true,
      requestId,
      latencyMs: Date.now() - start,
      data: {
        abn,
        businessName: 'Acme Technology Pty Ltd',
        sponsorStatus: 'approved',
        approvedOccupations: ['261313', '135111', '224711'],
        nominationQuota: 10,
        nominationsUsed: 3,
        expiryDate: '2027-06-30',
      },
    };
  }

  private sandboxVevoCheck(
    visaNumber: string,
    requestId: string,
    start: number,
  ): AdapterResponse<VevoCheckResponse> {
    this.logger.debug(`[SANDBOX] vevoCheck: ${visaNumber}`);
    return {
      success: true,
      sandbox: true,
      requestId,
      latencyMs: Date.now() - start,
      data: {
        visaNumber,
        status: 'valid',
        subclass: '482',
        conditions: ['8107', '8501'],
        workEntitlement: 'full',
        studyEntitlement: true,
        lastCheckedAt: new Date().toISOString(),
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
        message: `DHA API returned HTTP ${httpStatus}`,
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
    this.logger.error(`DHA API network error: ${msg}`);
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
