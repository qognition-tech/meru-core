import type { Request } from 'express';
import {
  EntityStatus,
  EntityType,
} from '../crm/entities/universal-entity.entity';

// ============================================================
// API Response Envelope (per ARCHITECTURE.md & DESIGN_GUIDELINES.md)
// All responses MUST follow: { data, meta, error }
// ============================================================

export interface ApiResponse<T = any> {
  /** Response payload — null on error */
  data: T | null;
  /** Metadata: pagination, timing, request ID, etc. */
  meta: ApiMeta;
  /** Error details — null on success */
  error: MeruError | null;
}

export interface ApiMeta {
  /** Unique request identifier (UUID) for tracing */
  requestId: string;
  /** ISO 8601 timestamp of response */
  timestamp: string;
  /** API version (e.g. "v1") */
  version: string;
  /** Pagination info (present for list endpoints) */
  pagination?: PaginationMeta;
  /** Rate limit info */
  rateLimit?: RateLimitMeta;
  /** Vertical context */
  vertical?: string;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface RateLimitMeta {
  limit: number;
  remaining: number;
  resetAt: string; // ISO 8601
}

// ============================================================
// Meru Error Codes (per DESIGN_GUIDELINES.md)
// ============================================================

export enum MeruErrorCode {
  // Auth (MER-AUTH-xxxx)
  AUTH_INVALID_CREDENTIALS = 'MER-AUTH-0001',
  AUTH_TOKEN_EXPIRED = 'MER-AUTH-0002',
  AUTH_TOKEN_INVALID = 'MER-AUTH-0003',
  AUTH_MFA_REQUIRED = 'MER-AUTH-0004',
  AUTH_MFA_INVALID = 'MER-AUTH-0005',
  AUTH_API_KEY_INVALID = 'MER-AUTH-0006',
  AUTH_API_KEY_EXPIRED = 'MER-AUTH-0007',
  AUTH_FORBIDDEN = 'MER-AUTH-0008',
  AUTH_INSUFFICIENT_ROLE = 'MER-AUTH-0009',

  // Tenant (MER-TENANT-xxxx)
  TENANT_NOT_FOUND = 'MER-TENANT-0001',
  TENANT_SLUG_TAKEN = 'MER-TENANT-0002',
  TENANT_SUSPENDED = 'MER-TENANT-0003',
  TENANT_QUOTA_EXCEEDED = 'MER-TENANT-0004',
  TENANT_INVALID_VERTICAL = 'MER-TENANT-0005',

  // Validation (MER-VAL-xxxx)
  VALIDATION_ERROR = 'MER-VAL-0001',
  VALIDATION_REQUIRED_FIELD = 'MER-VAL-0002',
  VALIDATION_INVALID_FORMAT = 'MER-VAL-0003',
  VALIDATION_DUPLICATE = 'MER-VAL-0004',
  VALIDATION_CONSTRAINT = 'MER-VAL-0005',

  // Resource (MER-RES-xxxx)
  RESOURCE_NOT_FOUND = 'MER-RES-0001',
  RESOURCE_ALREADY_EXISTS = 'MER-RES-0002',
  RESOURCE_DELETED = 'MER-RES-0003',
  RESOURCE_LOCKED = 'MER-RES-0004',
  RESOURCE_VERSION_CONFLICT = 'MER-RES-0005',

  // Rate Limiting (MER-RATE-xxxx)
  RATE_LIMIT_EXCEEDED = 'MER-RATE-0001',
  RATE_LIMIT_VERTICAL_EXCEEDED = 'MER-RATE-0002',

  // Server (MER-SRV-xxxx)
  SERVER_INTERNAL = 'MER-SRV-0001',
  SERVER_UNAVAILABLE = 'MER-SRV-0002',
  SERVER_TIMEOUT = 'MER-SRV-0003',
  SERVER_DATABASE = 'MER-SRV-0004',

  // External Services (MER-EXT-xxxx)
  EXTERNAL_SERVICE_ERROR = 'MER-EXT-0001',
  EXTERNAL_AI_ENGINE_ERROR = 'MER-EXT-0002',
  EXTERNAL_STORAGE_ERROR = 'MER-EXT-0003',
  EXTERNAL_SEARCH_ERROR = 'MER-EXT-0004',
  EXTERNAL_NOTIFICATION_ERROR = 'MER-EXT-0005',
}

export interface MeruError {
  /** Machine-readable error code (e.g. "MER-AUTH-0001") */
  code: MeruErrorCode;
  /** Human-readable error message */
  message: string;
  /** Optional validation error details (field-level) */
  details?: ValidationErrorDetail[];
  /** Optional troubleshooting link */
  helpUrl?: string;
}

export interface ValidationErrorDetail {
  field: string;
  message: string;
  code: string;
  receivedValue?: any;
}

// ============================================================
// JWT / Auth Types
// ============================================================

export interface JwtPayload {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

export interface UserPayload {
  id: string;
  email: string;
  tenantId: string;
  roles: string[];
  mfaEnabled?: boolean;
  apiKeyId?: string;
}

export interface TenantInfo {
  id: string;
  slug: string;
  vertical: string;
}

export interface AuthenticatedUser extends UserPayload {
  tenant: TenantInfo;
}

/**
 * Express request after the JWT/API-key guard has populated `req.user`.
 * Use in controllers handling authenticated routes so `req.user` is typed.
 */
export interface AuthenticatedRequest extends Request {
  user: UserPayload;
}

export interface CreateUserInput {
  tenantSlug: string;
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
}

/**
 * A user as rendered in a tenant's user directory.
 *
 * Deliberately not the `User` entity: it never carries `password`, `mfaSecret`
 * or the raw `attributes` bag, and it collapses `roles` into the single
 * `role` the portals switch on while still exposing the full list.
 */
export interface DirectoryUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  /** Display name — full name when known, otherwise the email. */
  name: string;
  /** Primary role, by precedence. See IamService.resolvePrimaryRole. */
  role: string;
  roles: string[];
  department: string | null;
  status: string;
  lastActiveAt: Date | null;
  createdAt: Date;
  avatarUrl: string | null;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface CreateEntityInput {
  type: EntityType;
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string;
  verticalAttributes?: Record<string, any>;
  /** Lifecycle. Defaults to `open` for workable types, null for the rest. */
  status?: EntityStatus;
  dueDate?: string;
  assignedTo?: string;
}

// ============================================================
// Tenant Vertical Types
// ============================================================

export type MeruVertical =
  | 'immigration'
  | 'banking'
  | 'health'
  | 'tax'
  | 'labour'
  | 'education';

export interface VerticalRateLimit {
  requestsPerMinute: number;
  requestsPerHour: number;
  burstMultiplier: number;
}

export const VERTICAL_RATE_LIMITS: Record<MeruVertical, VerticalRateLimit> = {
  immigration: {
    requestsPerMinute: 100,
    requestsPerHour: 5000,
    burstMultiplier: 1.5,
  },
  banking: {
    requestsPerMinute: 50,
    requestsPerHour: 2500,
    burstMultiplier: 1.2,
  },
  health: {
    requestsPerMinute: 75,
    requestsPerHour: 3000,
    burstMultiplier: 1.3,
  },
  tax: { requestsPerMinute: 60, requestsPerHour: 2500, burstMultiplier: 1.2 },
  labour: {
    requestsPerMinute: 80,
    requestsPerHour: 4000,
    burstMultiplier: 1.3,
  },
  education: {
    requestsPerMinute: 100,
    requestsPerHour: 5000,
    burstMultiplier: 1.5,
  },
};
