// Contract every government API adapter must implement.
// The INT module (CLAUDE.md §2 row 14) routes calls through this interface —
// vertical packs reference adapters by ID (e.g. "au-home-affairs"), never
// by concrete class.

export interface AdapterConfig {
  baseUrl: string;
  sandboxUrl?: string;
  authMethod: 'api_key' | 'oauth2' | 'mtls' | 'none';
  credentials?: Record<string, string>;
  timeoutMs?: number;
  rateLimitRpm?: number;
}

export interface AdapterResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  latencyMs: number;
  requestId: string;
  sandbox: boolean;
}

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'down';
  latencyMs: number;
  lastCheckedAt: Date;
  message?: string;
}

export interface GovernmentAdapter {
  readonly adapterId: string;
  readonly country: string;
  readonly regulatorName: string;

  // Every adapter exposes these three base methods.
  healthCheck(): Promise<HealthCheckResult>;
  isSandbox(): boolean;

  // Adapters optionally implement capability-specific methods.
  // Callers check `supportsCapability()` before calling.
  supportsCapability(capability: AdapterCapability): boolean;
}

export type AdapterCapability =
  | 'visa_status' // check a visa's current status
  | 'application_status' // check an application's status
  | 'sponsor_validation' // validate employer/sponsor licence
  | 'lodge_application' // e-lodge a visa application
  | 'screening' // run sanctions/watchlist screening
  | 'sar_filing' // file a suspicious activity report
  | 'document_verification' // verify document authenticity
  | 'identity_verification' // verify identity against national register
  | 'vevo_check' // AU-specific VEVO visa entitlement check
  | 'right_to_work' // UK-specific share-code right-to-work/rent check
  | 'visa_view'; // NZ-specific VisaView visa entitlement check
