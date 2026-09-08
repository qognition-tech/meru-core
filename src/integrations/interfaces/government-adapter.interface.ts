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
  /**
   * `'unknown'` added additively alongside the original three: a sandboxed
   * adapter's `healthCheck()` performs no I/O, so `'healthy'` there was never
   * an observed fact — it was the absence of a check reported as a result.
   * Existing producers of `'healthy' | 'degraded' | 'down'` still typecheck;
   * only the caller that decides sandbox adapters are unprobed needs to know
   * about this value.
   */
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  latencyMs: number;
  lastCheckedAt: Date;
  message?: string;
}

export interface GovernmentAdapter {
  readonly adapterId: string;
  readonly country: string;
  readonly regulatorName: string;

  // Every adapter exposes these four base methods.
  healthCheck(): Promise<HealthCheckResult>;
  isSandbox(): boolean;
  /**
   * Whether a live credential pair is configured for this adapter, independent
   * of whether live mode was actually requested (`isSandbox()` requires both).
   * Surfaced on `/integrations/adapters/health` so an operator can tell
   * "sandbox because nobody asked for live" from "sandbox because there is no
   * credential to go live with" — the same distinction `hasCredentials` on
   * `/integrations/connectors` already draws for the tenant's own connectors.
   */
  hasCredentials(): boolean;

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
