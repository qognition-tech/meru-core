# Meru RegOS — Technical Requirements Document

> **Version**: 1.1 | **Status**: Phase A/B/C complete — active implementation
> **Owner**: Meru Platform Team | **Last Updated**: 2026-05-31
>
> This document provides **detailed technical specifications** for implementation teams.
> See also: [ARCHITECTURE.md](./ARCHITECTURE.md) · [PRD.md](./PRD.md) · [STRATEGY.md](./STRATEGY.md)

---

## Table of Contents

1. [API Contracts](#1-api-contracts)
2. [Database Schema](#2-database-schema)
3. [Authentication & Authorization](#3-authentication--authorization)
4. [Multi-Tenancy Implementation](#4-multi-tenancy-implementation)
5. [Document Management](#5-document-management)
6. [AI Gateway Specification](#6-ai-gateway-specification)
7. [Workflow Engine](#7-workflow-engine)
8. [Screening Engine](#8-screening-engine)
9. [Integration Hub](#9-integration-hub)
10. [Frontend Integration Specification](#10-frontend-integration-specification)
11. [Infrastructure Requirements](#11-infrastructure-requirements)
12. [Security Requirements](#12-security-requirements)
13. [Performance Budgets](#13-performance-budgets)

---

## 1. API Contracts

### 1.1 Base URL & Versioning

All API endpoints are prefixed with `/api/v1`. The API version is part of the URL path. Breaking changes require a new major version (`/api/v2`).

### 1.2 Standard Response Envelope

Every API response follows this structure:

```json
{
  "data": { },
  "meta": {
    "requestId": "uuid",
    "timestamp": "2026-05-28T12:00:00Z",
    "page": 1,
    "limit": 20,
    "total": 150
  },
  "error": null
}
```

Error responses:

```json
{
  "data": null,
  "meta": {
    "requestId": "uuid",
    "timestamp": "2026-05-28T12:00:00Z"
  },
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Email is required",
    "details": [
      { "field": "email", "message": "Email is required" }
    ]
  }
}
```

### 1.3 Standard Headers

| Header | Direction | Required | Description |
|---|---|---|---|
| `Authorization` | Request | For protected routes | `Bearer <jwt>` |
| `X-Tenant-ID` | Request | For multi-tenant routes | Tenant UUID |
| `X-Request-ID` | Request | Optional (auto-generated) | Idempotency key |
| `Content-Type` | Request | Yes | `application/json` or `multipart/form-data` |
| `X-Response-Time` | Response | Always | Server processing time in ms |
| `X-RateLimit-Remaining` | Response | Always | Remaining requests in window |

### 1.4 Complete API Reference

#### Authentication

| Method | Path | Auth | Request Body | Response |
|---|---|---|---|---|
| `POST` | `/api/v1/auth/login` | Local | `{ email, password, rememberMe? }` | `{ accessToken, refreshToken, user }` |
| `POST` | `/api/v1/auth/refresh` | None | `{ refreshToken }` | `{ accessToken, refreshToken }` |
| `POST` | `/api/v1/auth/logout` | JWT | — | `{ success: true }` |
| `POST` | `/api/v1/auth/register` | None | `{ email, password, name, firmName }` | `{ accessToken, refreshToken, user, tenant }` |
| `GET` | `/api/v1/auth/profile` | JWT | — | `{ user }` |
| `POST` | `/api/v1/auth/forgot-password` | None | `{ email }` | `{ success: true }` |
| `POST` | `/api/v1/auth/reset-password` | None | `{ token, newPassword }` | `{ success: true }` |
| `POST` | `/api/v1/auth/saml/:tenantSlug` | SAML | SP-initiated redirect | Redirect to IdP |
| `POST` | `/api/v1/auth/saml/:tenantSlug/callback` | SAML | SAML Response | `{ accessToken, refreshToken, user }` |

#### Tenants

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/tenants/provision` | None | Create tenant + admin user atomically |
| `GET` | `/api/v1/tenants/me` | JWT | Get current tenant config |
| `PATCH` | `/api/v1/tenants/me` | JWT+Admin | Update tenant settings |
| `POST` | `/api/v1/tenants/onboard` | JWT+Admin | Complete onboarding wizard |
| `GET` | `/api/v1/tenants/check-slug` | None | Check if tenant slug is available |

#### CRM — Entities

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/crm/entities` | JWT | List entities. Query: `?type=person&vertical=immigration&page=1&limit=20` |
| `POST` | `/api/v1/crm/entities` | JWT | Create entity. Body includes `verticalAttributes` |
| `GET` | `/api/v1/crm/entities/:id` | JWT | Get entity with relationships |
| `PATCH` | `/api/v1/crm/entities/:id` | JWT | Partial update (merges `verticalAttributes`) |
| `DELETE` | `/api/v1/crm/entities/:id` | JWT+Admin | Soft delete |
| `GET` | `/api/v1/crm/leads` | JWT | List leads with scores. Query: `?status=new&source=website` |
| `POST` | `/api/v1/crm/leads/convert` | JWT | Convert lead to client entity |

#### Cases

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/cases` | JWT | List cases. Query: `?stage=documents_pending&assigned_to=:userId` |
| `POST` | `/api/v1/cases` | JWT | Create case linked to entity |
| `GET` | `/api/v1/cases/:id` | JWT | Get case with timeline, tasks, documents |
| `PATCH` | `/api/v1/cases/:id` | JWT | Update case fields |
| `PATCH` | `/api/v1/cases/:id/stage` | JWT | Transition to new stage (body: `{ stage, notes? }`) |
| `DELETE` | `/api/v1/cases/:id` | JWT+Admin | Archive case |
| `GET` | `/api/v1/cases/:id/timeline` | JWT | Get case timeline with all state transitions |

#### Tasks

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/tasks` | JWT | List tasks. Query: `?status=todo&assigned_to=:userId&priority=high` |
| `POST` | `/api/v1/tasks` | JWT | Create task. Body: `{ title, description, case_id?, assigned_to?, priority, due_date, type }` |
| `PATCH` | `/api/v1/tasks/:id` | JWT | Update task (partial) |
| `DELETE` | `/api/v1/tasks/:id` | JWT+Admin | Delete task |
| `POST` | `/api/v1/tasks/:id/comments` | JWT | Add comment to task |

#### Documents

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/documents` | JWT | List documents. Query: `?entity_id=:id&type=passport&status=verified` |
| `POST` | `/api/v1/documents/upload` | JWT | Upload file (multipart). Body: `{ file, entity_id, type, tags? }` |
| `GET` | `/api/v1/documents/:id` | JWT | Get document metadata |
| `GET` | `/api/v1/documents/:id/download` | JWT | Download file (stream) |
| `DELETE` | `/api/v1/documents/:id` | JWT+Admin | Delete document + all versions |
| `POST` | `/api/v1/documents/request` | JWT | Request document from client. Body: `{ entity_id, document_type, due_date, notes }` |
| `PATCH` | `/api/v1/documents/:id/verify` | JWT | Mark as verified/rejected. Body: `{ status, notes? }` |

#### Payments

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/payments` | JWT | List payments. Query: `?case_id=:id&status=overdue` |
| `POST` | `/api/v1/payments` | JWT | Create payment record |
| `PATCH` | `/api/v1/payments/:id` | JWT | Update payment status |
| `POST` | `/api/v1/payments/invoice` | JWT+Admin | Generate invoice. Body: `{ case_id, template, line_items, tax_rate }` |
| `POST` | `/api/v1/payments/link` | JWT+Admin | Generate Stripe payment link. Body: `{ amount, currency, description }` |

#### Communications

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/communications` | JWT | List communications. Query: `?entity_id=:id&channel=whatsapp` |
| `POST` | `/api/v1/communications` | JWT | Send message. Body: `{ entity_id, channel, content, template_id?, file_note? }` |
| `GET` | `/api/v1/communications/:id` | JWT | Get message thread |

#### AI

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/ai/execute` | JWT | Execute AI prompt. Body: `{ category, key?, input, context? }` |
| `POST` | `/api/v1/ai/chat` | JWT | Streaming chat. Body: `{ messages[], context? }`. Response: SSE stream |
| `POST` | `/api/v1/ai/analyze-entity` | JWT | Analyze entity with AI. Body: `{ entity_id }` |
| `POST` | `/api/v1/ai/embeddings` | JWT | Create embedding. Body: `{ text, type, resourceId }` |
| `GET` | `/api/v1/ai/search` | JWT | Semantic search. Query: `?q=query&type=document&limit=5` |
| `GET` | `/api/v1/ai/prompts` | JWT | List available prompts |
| `POST` | `/api/v1/ai/prompts` | JWT+Admin | Create/update prompt |

#### Analytics

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/analytics/dashboard` | JWT | Dashboard data. Query: `?period=30d` |
| `GET` | `/api/v1/analytics/revenue` | JWT | Revenue analytics. Query: `?period=monthly&from=2026-01-01&to=2026-05-31` |
| `GET` | `/api/v1/analytics/cases` | JWT | Case analytics |
| `GET` | `/api/v1/analytics/staff` | JWT+Admin | Staff performance analytics |
| `GET` | `/api/v1/analytics/reports` | JWT | List reports |
| `POST` | `/api/v1/analytics/reports` | JWT+Admin | Create custom report |
| `GET` | `/api/v1/analytics/reports/:id/export` | JWT | Export report (CSV/PDF) |

#### Search, Config, Platform, Notifications

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/search` | JWT | Universal search. Query: `?q=query&modules=crm,cases,documents` |
| `GET` | `/api/v1/config/visa-categories` | JWT | List visa categories. Query: `?country=AU` |
| `GET` | `/api/v1/config/workflows` | JWT | List workflow definitions |
| `GET` | `/api/v1/config/countries` | JWT | List configured countries |
| `GET` | `/api/v1/platform/tenants` | Platform | List all tenants (God View) |
| `GET` | `/api/v1/platform/stats` | Platform | Global platform statistics |
| `POST` | `/api/v1/platform/tenants/:id/impersonate` | Platform | Impersonate tenant (audit logged) |
| `GET` | `/api/v1/notifications` | JWT | List user notifications |
| `POST` | `/api/v1/notifications/subscribe` | JWT | Subscribe to push notifications |
| `PATCH` | `/api/v1/notifications/preferences` | JWT | Update notification preferences |

#### Users & Staff

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/users` | JWT+Admin | List users. Query: `?role=agent&status=active` |
| `POST` | `/api/v1/users/invite` | JWT+Admin | Invite user. Body: `{ email, role, country_access?, visa_type_access? }` |
| `PATCH` | `/api/v1/users/:id` | JWT+Admin | Update user (role, permissions, status) |
| `DELETE` | `/api/v1/users/:id` | JWT+Admin | Deactivate user |

#### Branding

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/tenant/branding` | JWT | Get branding config |
| `POST` | `/api/v1/tenant/branding` | JWT+Admin | Update branding (logo upload multipart) |
| `POST` | `/api/v1/tenant/branding/extract` | JWT+Admin | Extract brand from URL. Body: `{ url }` |

---

## 2. Database Schema

### 2.1 Core Tables (DDL Reference)

#### tenants

```sql
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    vertical vertical_type_enum NOT NULL,
    status tenant_status_enum DEFAULT 'trial',
    plan tenant_plan_enum DEFAULT 'free',
    settings JSONB DEFAULT '{}',
    sso_config JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    trial_ends_at TIMESTAMP,
    subscription_renews_at TIMESTAMP,
    deleted_at TIMESTAMP,
    vertical TEXT,
    environment TEXT
);

CREATE INDEX idx_tenants_slug ON tenants(slug);
CREATE INDEX idx_tenants_status ON tenants(status);
CREATE INDEX idx_tenants_vertical ON tenants(vertical);
```

#### users

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    vertical VARCHAR(50),
    environment VARCHAR(50),
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,  -- bcrypt hash, select: false
    provider auth_provider_enum DEFAULT 'local',
    roles TEXT[] DEFAULT '{user}',
    attributes JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_email ON users(email);
```

#### universal_entities

```sql
CREATE TABLE universal_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    vertical VARCHAR(50),
    environment VARCHAR(50),
    type entity_type_enum NOT NULL,  -- 'person' | 'organization'
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    email VARCHAR(255),
    phone_number VARCHAR(50),
    vertical_attributes JSONB DEFAULT '{}',  -- Vertical-specific fields
    relationships JSONB DEFAULT '[]',        -- [{id, type}]
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_entities_tenant ON universal_entities(tenant_id);
CREATE INDEX idx_entities_email ON universal_entities(tenant_id, email);
CREATE INDEX idx_entities_type ON universal_entities(tenant_id, type);
CREATE INDEX idx_entities_vertical_attrs ON universal_entities USING GIN (vertical_attributes);
```

#### documents

```sql
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    vertical VARCHAR(50),
    environment VARCHAR(50),
    name VARCHAR(500) NOT NULL,
    slug VARCHAR(500) UNIQUE NOT NULL,
    file_type document_type_enum NOT NULL,  -- pdf, image, word, excel, other
    original_file_name VARCHAR(500),
    file_size BIGINT,
    mime_type VARCHAR(100),
    status document_status_enum DEFAULT 'uploaded',
    encryption encryption_enum DEFAULT 'aes256',
    required_encryption BOOLEAN DEFAULT false,
    linked_entity_type VARCHAR(50),
    linked_entity_id UUID,
    tags JSONB DEFAULT '[]',
    metadata JSONB DEFAULT '{}',
    ai_analysis JSONB DEFAULT '{}',
    rbac JSONB DEFAULT '{"owner": null, "roles": [], "permissions": {}}',
    version_number INT DEFAULT 1,
    current_version_id UUID,
    s3_url TEXT,
    uploaded_by_id UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_docs_tenant ON documents(tenant_id);
CREATE INDEX idx_docs_entity ON documents(tenant_id, linked_entity_type, linked_entity_id);
CREATE INDEX idx_docs_status ON documents(tenant_id, status);
```

#### workflow_instances

```sql
CREATE TABLE workflow_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    vertical VARCHAR(50),
    environment VARCHAR(50),
    workflow_id UUID NOT NULL REFERENCES workflows(id),
    entity_id UUID NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    current_state_id UUID NOT NULL REFERENCES workflow_states(id),
    status instance_status_enum DEFAULT 'active',
    context JSONB DEFAULT '{}',
    history JSONB DEFAULT '[]',
    sla_deadline TIMESTAMP,
    escalation_level INT DEFAULT 0,
    sla_violations JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### audit_logs

```sql
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    vertical VARCHAR(50),
    environment VARCHAR(50),
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID,
    user_id UUID,
    changes JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    hash VARCHAR(64) NOT NULL,           -- SHA-256 of this entry
    previous_hash VARCHAR(64),           -- SHA-256 of previous entry (chain)
    compliance_standard VARCHAR(50),     -- 'gdpr', 'soc2', 'iso27001', 'aml'
    severity audit_severity_enum DEFAULT 'info',
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_tenant ON audit_logs(tenant_id);
CREATE INDEX idx_audit_entity ON audit_logs(tenant_id, entity_type, entity_id);
CREATE INDEX idx_audit_action ON audit_logs(tenant_id, action);
CREATE INDEX idx_audit_compliance ON audit_logs(tenant_id, compliance_standard);
```

### 2.2 Enums

```sql
CREATE TYPE vertical_type_enum AS ENUM ('immigration', 'grc', 'labour', 'fintech', 'legal');
CREATE TYPE auth_provider_enum AS ENUM ('local', 'saml', 'oidc');
CREATE TYPE entity_type_enum AS ENUM ('person', 'organization');
CREATE TYPE document_type_enum AS ENUM ('pdf', 'image', 'word', 'excel', 'other');
CREATE TYPE document_status_enum AS ENUM ('uploaded', 'processing', 'verified', 'rejected', 'expired', 'archived');
CREATE TYPE instance_status_enum AS ENUM ('active', 'paused', 'completed', 'cancelled', 'escalated');
CREATE TYPE audit_severity_enum AS ENUM ('debug', 'info', 'warning', 'error', 'critical');
CREATE TYPE tenant_status_enum AS ENUM ('active', 'suspended', 'deleted', 'trial');
CREATE TYPE tenant_plan_enum AS ENUM ('free', 'starter', 'professional', 'enterprise');
```

### 2.3 RLS Policies

Every table must have RLS enabled with vertical + environment isolation:

```sql
-- Enable RLS on all tables
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- ... (all 43 tables)

-- Create context-setting function
CREATE OR REPLACE FUNCTION app.set_context(p_vertical TEXT, p_environment TEXT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('app.current_vertical', p_vertical, false);
    PERFORM set_config('app.current_environment', p_environment, false);
END; $$;

-- Standard isolation policy (applied to every table)
CREATE POLICY tenant_vertical_isolation ON universal_entities
    FOR ALL
    USING (
        vertical = current_setting('app.current_vertical')
        AND environment = current_setting('app.current_environment')
    )
    WITH CHECK (
        vertical = current_setting('app.current_vertical')
        AND environment = current_setting('app.current_environment')
    );

-- Superuser override (platform admins)
CREATE OR REPLACE FUNCTION app.set_superuser()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('app.is_superuser', 'true', false);
END; $$;

CREATE POLICY superuser_access ON universal_entities
    FOR ALL
    USING (current_setting('app.is_superuser', true) = 'true');
```

---

## 3. Authentication & Authorization

### 3.1 JWT Structure

```typescript
interface JwtPayload {
  sub: string;           // User UUID
  email: string;         // User email
  tenantId: string;      // Tenant UUID
  tenantSlug: string;    // Tenant slug (e.g., 'acme-immigration')
  vertical: string;      // 'immigration' | 'grc' | 'labour' | ...
  environment: string;   // 'development' | 'staging' | 'production'
  roles: string[];       // ['admin', 'staff'] or ['client']
  iat: number;           // Issued at (Unix timestamp)
  exp: number;           // Expiration (Unix timestamp)
}
```

**Token Lifetime**:
- Access token: 15 minutes (default) or 30 days (if "Remember me" checked)
- Refresh token: 30 days
- Token signing: RS256 (RSA 2048-bit key pair)

### 3.2 Role Hierarchy & Permission Matrix

| Role | View Cases | Edit Cases | Manage Staff | Billing | Platform Admin | Client Portal |
|---|---|---|---|---|---|---|
| `platform_admin` | All tenants | All tenants | All tenants | All tenants | Yes | No |
| `firm_admin` | All (tenant) | All (tenant) | Yes | Yes | No | No |
| `senior_agent` | All (tenant) | Assigned + all | No | No | No | No |
| `agent` | Assigned | Assigned | No | No | No | No |
| `client` | Own cases | Own documents | No | Own payments | No | Yes |

### 3.3 SAML SSO Flow

```
1. Firm admin configures SAML in tenant settings:
   POST /api/v1/tenants/me → { ssoConfig: { provider: 'saml', entryPoint, cert, issuer } }

2. User visits login page, enters email → system detects SAML tenant

3. SP-initiated redirect:
   GET /api/v1/auth/saml/:tenantSlug → redirect to IdP

4. IdP authenticates user, POSTs SAML Response to:
   POST /api/v1/auth/saml/:tenantSlug/callback

5. SAML strategy validates assertion, extracts attributes:
   - email → matches existing user or JIT provisions new user
   - roles → mapped from SAML attributes
   - tenantId → derived from tenantSlug

6. System returns JWT access + refresh tokens
```

### 3.4 Guard Logic

```typescript
// PolicyGuard — evaluates RBAC + optional constraints
@Injectable()
export class PolicyGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.get<string[]>('roles', context.getHandler());
    if (!requiredRoles) return true; // No roles required = public

    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload;

    // 1. Role check
    const hasRole = requiredRoles.some(role => user.roles.includes(role));
    if (!hasRole) return false;

    // 2. IP whitelist (if configured for tenant)
    const tenantSettings = await this.tenantService.getSettings(user.tenantId);
    if (tenantSettings.ipWhitelist?.length > 0) {
      const clientIp = request.ip;
      if (!tenantSettings.ipWhitelist.includes(clientIp)) return false;
    }

    // 3. Business hours restriction (if configured)
    if (tenantSettings.businessHoursOnly) {
      const now = new Date();
      const hour = now.getHours();
      if (hour < 8 || hour > 20) return false; // Configurable per tenant
    }

    return true;
  }
}
```

---

## 4. Multi-Tenancy Implementation

### 4.1 Tenant Context Middleware

The middleware (`TenantContextMiddleware`) runs on every request and sets the PostgreSQL RLS context based on domain routing.

```typescript
// Domain → Vertical + Environment mapping
const domainMapping = {
  'api.immistack.com':    { vertical: 'immigration', baseUrl: 'immistack.com' },
  'api.governancex.com':  { vertical: 'grc', baseUrl: 'governancex.com' },
  'api.meru.com':         { vertical: 'meru', baseUrl: 'meru.com' },
};

const envPrefixes = {
  'dev-api':    'development',
  'staging-api': 'staging',
  'api':        'production',
};
```

**Localhost development**: Uses `TEST_VERTICAL` and `TEST_ENV` environment variables for context simulation.

### 4.2 Tenant Provisioning

Atomic tenant + admin user creation:

```typescript
// TenantProvisioningService
async provisionTenant(dto: ProvisionTenantDto) {
  return this.dataSource.transaction(async (manager) => {
    // 1. Create tenant
    const tenant = manager.create(Tenant, {
      slug: dto.slug,
      name: dto.firmName,
      vertical: dto.vertical,
      status: TenantStatus.TRIAL,
      plan: TenantPlan.FREE,
      trialEndsAt: addDays(new Date(), 14),
    });
    await manager.save(tenant);

    // 2. Create admin user
    const user = manager.create(User, {
      tenantId: tenant.id,
      email: dto.adminEmail,
      password: await bcrypt.hash(dto.adminPassword, 12),
      roles: ['firm_admin'],
      vertical: dto.vertical,
      environment: 'production',
    });
    await manager.save(user);

    // 3. Create default tenant settings (from vertical config pack)
    const settings = manager.create(TenantSetting, {
      tenantId: tenant.id,
      config: this.loadDefaultConfig(dto.vertical),
      vertical: dto.vertical,
      environment: 'production',
    });
    await manager.save(settings);

    return { tenant, user };
  });
}
```

### 4.3 S3 Storage Isolation

```
Bucket: meru-documents-{environment}
Path pattern: {vertical}/{tenant_id}/{document_uuid}/{version}/

Encryption:
- Default: SSE-S3 (AWS-managed keys)
- Regulated verticals (immigration, grc): SSE-KMS with per-vertical customer-managed keys
- Key rotation: 90 days automatic

Lifecycle policies:
- Deleted documents: move to Glacier after 30 days
- Audit logs: never delete (WORM)
```

---

## 5. Document Management

### 5.1 Upload Pipeline

```
1. Client/Staff selects file (browser)
2. Frontend validates: type (pdf, image, word, excel), size (max 50MB)
3. POST /api/v1/documents/upload (multipart/form-data)
4. Server validates: mime type, file size, tenant storage quota
5. Generate unique filename: {uuid}-{original_name}
6. Encrypt: AES-256-GCM with per-vertical KMS key
7. Upload to S3: s3://meru-documents/{vertical}/{tenant_id}/{document_uuid}/v1.pdf
8. Store metadata in documents table
9. Trigger async OCR pipeline (if image/pdf):
   a. Queue OCR job → Document Intelligence engine
   b. Extract text → store in document_metadata
   c. AI analysis → entity extraction, classification
10. Create audit log entry
11. Return document metadata to client
```

### 5.2 Versioning

```sql
-- When a new version of a document is uploaded:
-- 1. Create new DocumentVersion record
-- 2. Update Document.version_number, Document.current_version_id, Document.s3_url
-- 3. Old versions remain in S3 (immutable)

document_versions:
  - id: UUID (PK)
  - document_id: UUID (FK → documents)
  - version_number: INT
  - s3_key: TEXT
  - s3_bucket: TEXT
  - file_size: BIGINT
  - checksum: VARCHAR(64)  -- SHA-256
  - encryption_key: TEXT
  - encryption_algorithm: VARCHAR(50)
  - uploaded_by_id: UUID
  - change_description: TEXT
  - created_at: TIMESTAMP
```

### 5.3 Document RBAC

```json
{
  "owner": "user-uuid-123",
  "roles": ["firm_admin", "senior_agent"],
  "permissions": {
    "read": ["agent", "client"],
    "write": ["firm_admin", "senior_agent"],
    "delete": ["firm_admin"],
    "share": ["firm_admin"]
  }
}
```

Access check: `DocumentAuthGuard` reads the `rbac` JSONB, checks requesting user's roles against required permissions, and allows/denies the operation.

---

## 6. AI Gateway Specification

### 6.1 Model Routing

```typescript
// Prompt-based routing (each prompt has a preferredProvider)
switch (prompt.preferredProvider) {
  case ModelProvider.OPENAI:
    return this.executeOpenAI(fullPrompt, prompt);
  case ModelProvider.ANTHROPIC:
    return this.executeAnthropic(fullPrompt, prompt);
  case ModelProvider.AZURE:
    return this.executeAzureOpenAI(fullPrompt, prompt);
  case ModelProvider.LOCAL:
    return this.executeLocalModel(fullPrompt, prompt);
  default:
    return this.executeOpenAI(fullPrompt, prompt); // Default fallback
}
```

### 6.2 Default Prompt Configuration

```json
{
  "entity_analysis_immigration": {
    "category": "entity_analysis",
    "key": "immigration_entity_analysis",
    "prompt": "Analyze this immigration entity: {{INPUT}}. Identify visa type, country, risk factors, and required documents.",
    "preferredProvider": "openai",
    "modelConfig": { "model": "gpt-4o-mini", "temperature": 0.3, "maxTokens": 500 }
  },
  "document_extraction": {
    "category": "data_extraction",
    "key": "document_extraction",
    "prompt": "Extract the following fields from this document: {{FIELDS}}. Document content: {{INPUT}}.",
    "preferredProvider": "openai",
    "modelConfig": { "model": "gpt-4o", "temperature": 0.1, "maxTokens": 1000 }
  }
}
```

### 6.3 Citation Enforcement

For `COMPLIANCE_ANALYSIS` category prompts, the AI response MUST include inline citations in the format `[Source: url]`. The enforcement mechanism:

```typescript
function enforceCitations(response: string, category: PromptCategory): string {
  if (category === PromptCategory.COMPLIANCE_ANALYSIS) {
    const citationPattern = /\[Source:\s*(https?:\/\/[^\]]+)\]/gi;
    const hasCitations = citationPattern.test(response);
    if (!hasCitations) {
      return "I don't have a verified source for this. Please consult official regulatory sources or contact your compliance officer.";
    }
  }
  return response;
}
```

### 6.4 Embedding Specification

- **Model**: `text-embedding-3-small` (OpenAI) — 1536 dimensions
- **Or**: `text-embedding-ada-002` (fallback for cost optimization)
- **Max input length**: 8191 tokens per embedding
- **Storage**: `ai_embeddings` table, `vector` column as JSONB
- **Similarity**: Cosine similarity (implementation: `AiService.cosineSimilarity()`)

### 6.5 Rate Limiting & Token Management

- Per-tenant rate limit: 100 AI requests/minute
- Token budget per tenant per month (configurable by plan)
- Hard cap enforcement: requests rejected with 429 when budget exceeded
- Token usage tracking: logged per request, aggregated per tenant per day

---

## 7. Workflow Engine

### 7.1 State Machine Specification

Each workflow is a directed graph:
- **States** (`workflow_states`): Nodes in the graph with type (`start`, `intermediate`, `end`, `escalation`)
- **Transitions** (`workflow_transitions`): Edges with conditions, actions, and permissions
- **Instances** (`workflow_instances`): Running instances with current state, context, history

### 7.2 Transition Conditions

Conditions are JSON expressions evaluated against instance context:

```json
{
  "conditions": [
    { "field": "context.documents_complete", "operator": "eq", "value": true },
    { "field": "context.payment_status", "operator": "eq", "value": "paid" },
    { "field": "context.client_approved", "operator": "eq", "value": true }
  ],
  "logic": "AND"
}
```

Supported operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`, `regex`, `exists`, `empty`.

### 7.3 Transition Actions

Actions are executed when a transition fires:

```json
{
  "actions": [
    { "type": "send_notification", "config": { "template": "stage_changed", "recipient": "client" } },
    { "type": "create_task", "config": { "title": "Review application", "assigned_role": "senior_agent" } },
    { "type": "update_entity", "config": { "field": "verticalAttributes.application_stage", "value": "{{new_state}}" } },
    { "type": "webhook", "config": { "url": "https://...", "method": "POST" } }
  ]
}
```

### 7.4 SLA Watchdog Algorithm

```
Every 60 seconds:
  1. Query all active workflow instances where sla_deadline < NOW()
  2. For each breached instance:
     a. Increment escalation_level
     b. Log SLA violation in sla_violations[] with timestamp
     c. Calculate new deadline: NOW() + (escalation_level * grace_period)
     d. Fire escalation notification based on level:
        Level 1 → Notify assigned staff
        Level 2 → Notify senior agent
        Level 3 → Notify firm admin
        Level 4+ → Notify all + mark case as critical
  3. Update sla_deadline in database
```

---

## 8. Screening Engine

### 8.1 Fuzzy Matching Algorithm Specification

```typescript
interface ScreeningResult {
  inputName: string;
  inputNameNormalized: string;
  matches: ScreeningMatch[];
  highestScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

interface ScreeningMatch {
  listName: string;          // 'OFAC', 'EU', 'UN', etc.
  listEntryId: string;
  matchedName: string;
  scores: {
    levenshtein: number;     // 0–1, edit distance normalized
    jaroWinkler: number;     // 0–1, phonetic similarity
    soundex: boolean;        // phonetic code match
    ngramOverlap: number;    // 0–1, 3-gram overlap
    embeddingCosine: number; // 0–1, semantic similarity
  };
  weightedScore: number;     // 0–100, weighted ensemble
}
```

**Weight Configuration** (default, adjustable per tenant risk appetite):
```
Weighted Score = (levenshtein × 0.25) + (jaroWinkler × 0.30) + (soundex_match × 0.10) + (ngram × 0.20) + (embedding × 0.15)
```

**Scoring Thresholds** (defaults, configurable):
- Score ≥ 85: Critical match — immediate alert + case creation
- Score 70–84: High match — review queue
- Score 50–69: Medium match — logged for review
- Score < 50: Low match — informational only

### 8.2 Transliteration Normalization

Arabic ↔ Latin normalization pipeline:

```
Arabic Input: "محمد بن راشد"
  → Buckwalter Transliteration: "mHmd bn rA$d"
  → Latin Normalization: "mohammed bin rashid"
  → Standardized Form: "MOHAMMED BIN RASHID"

  Comparison against: "MOHAMED BIN RASHED" → Levenshtein: 0.91 (high match)
```

### 8.3 Sanctions List Auto-Sync

```
Every 24 hours:
  1. Download latest lists from:
     - OFAC: https://www.treasury.gov/ofac/downloads/sdn.csv
     - EU: https://data.europa.eu/euodp/data/api/...
     - UN: https://scsanctions.un.org/resources/xml/en/consolidated.xml
     - UK HMT: https://www.gov.uk/government/publications/...
     - UAE Local: https://www.uaeiec.gov.ae/...
  2. Parse and normalize all entries
  3. Store in local database with version number
  4. Log sync event to audit trail
  5. Trigger re-screening of all active entities (batch job)
```

### 8.4 Batch Processing Architecture

```
Batch screening job (Bull queue):
  1. Accept batch of up to 10,000 names
  2. Split into chunks of 100 names
  3. Process chunks in parallel (up to 10 concurrent workers)
  4. Run each name through the fuzzy matching pipeline (Section 8.1)
  5. Collect results, apply thresholds
  6. Generate batch report (CSV)
  7. Flag matches above threshold for human review
  8. Log to audit trail
```

**Performance Target**: 10,000 names in < 60 seconds (requires optimized PostgreSQL indexes and Redis caching for sanctions lists).

---

## 9. Integration Hub

### 9.1 Government Adapter Interface

```typescript
interface GovernmentAdapter {
  /** Unique identifier for this adapter */
  readonly name: string;

  /** Country code this adapter serves */
  readonly country: CountryCode;

  /** Vertical this adapter is for */
  readonly vertical: VerticalType;

  /** Authenticate with the government API */
  authenticate(): Promise<AdapterToken>;

  /** Sync data from government since the given date. Returns async iterator for streaming large datasets. */
  syncData(since: Date, filters?: Record<string, any>): AsyncIterator<Record>;

  /** Push data to government system (e.g., submit application, file report) */
  pushData(data: Record): Promise<PushResult>;

  /** Check adapter health */
  healthCheck(): Promise<HealthStatus>;
}

interface AdapterToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scope?: string[];
}

interface PushResult {
  success: boolean;
  referenceId: string;     // Government system reference
  status: 'accepted' | 'pending' | 'rejected';
  message?: string;
  rawResponse?: Record;
}
```

### 9.2 Adapters (Active + Planned)

| Adapter | Country | Vertical | Type | Status |
|---|---|---|---|---|
| HomeAffairs (ImmiAccount) | AU | Immigration | REST/SOAP | **Active** — `src/integrations/adapters/au-home-affairs.adapter.ts` |
| UAE Central Bank (CBUAE) | AE | Banking | REST | **Active** — `src/integrations/adapters/uae-central-bank.adapter.ts` |
| VEVO | AU | Immigration | REST | Planned P1 |
| IRCC | CA | Immigration | REST | Planned P2 |
| UKVI (Home Office) | UK | Immigration | REST | Planned P2 |
| Finacle Core Banking | Global | Banking | SOAP/REST | Planned P1 |
| World-Check One | Global | Banking | REST | Planned P2 |
| Dow Jones Risk & Compliance | Global | Banking | REST | Planned P2 |
| SAMA | KSA | Banking | REST | Planned P3 |
| ZATCA | KSA | Tax | REST | Planned P3 |
| MOHRE | AE | Labour | REST | Planned P3 |

### 9.3 Adapter Configuration

Each adapter is configured per tenant via `INT` module settings:

```json
{
  "adapters": {
    "homeaffairs_au": {
      "enabled": true,
      "credentials": {
        "apiKey": "encrypted-value",
        "endpoint": "https://api.homeaffairs.gov.au/v2"
      },
      "rateLimit": {
        "maxRequestsPerMinute": 60,
        "retryStrategy": "exponential_backoff",
        "maxRetries": 3
      }
    }
  }
}
```

---

## 10. Frontend Integration Specification

### 10.1 API Client Architecture

The frontend API client (`lib/api/client.ts` in ImmiStack) follows this pattern:

```typescript
// 1. Create Axios instance
const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_MERU_API_URL || 'http://localhost:8000/api/v1',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// 2. Request interceptor — inject auth + tenant
apiClient.interceptors.request.use((config) => {
  const token = getAccessToken();  // From Zustand store
  const tenantId = getTenantId();  // From localStorage

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  if (tenantId) {
    config.headers['X-Tenant-ID'] = tenantId;
  }
  return config;
});

// 3. Response interceptor — token refresh
let isRefreshing = false;
let failedQueue: Array<{ resolve, reject }> = [];

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      if (isRefreshing) {
        // Queue this request until refresh completes
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((token) => {
          originalRequest.headers.Authorization = `Bearer ${token}`;
          return apiClient(originalRequest);
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const newToken = await refreshAccessToken();
        processQueue(null, newToken);
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return apiClient(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        // Redirect to login
        window.location.href = '/login';
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);
```

### 10.2 Mock Mode

When `NEXT_PUBLIC_MOCK_MODE !== "false"` or the API URL is localhost, the client falls back to a mock API layer backed by static dummy data. This allows full frontend development without a running backend.

**Mock API structure** (`lib/mocks/mock-api.ts`):
- Intercepts all Axios requests
- Routes to handler functions for each endpoint pattern
- Adds realistic latency (100–500ms random)
- Returns data from `lib/mocks/dummy-data.ts`

**Current state**: Fully implemented in ImmiStack. Must be disabled for production.

### 10.3 Required Environment Variables

```env
# Frontend (Next.js)
NEXT_PUBLIC_MERU_API_URL=http://localhost:8000/api/v1
NEXT_PUBLIC_APP_NAME=ImmiStack
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_MOCK_MODE=true              # Set to "false" for production
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=<random-64-char-string>

# Backend (NestJS)
NODE_ENV=development
VERTICAL=immigration
PORT=8000
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=meru_immigration_dev
DATABASE_USERNAME=postgres
DATABASE_PASSWORD=postgres
JWT_SECRET=<random-64-char-string>
OPENAI_API_KEY=sk-...
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
DOCUMENT_ENCRYPTION_KEY=<aes-256-key>
MAX_FILE_SIZE=52428800                  # 50MB
```

---

## 11. Infrastructure Requirements

### 11.1 Compute

| Environment | Instance Type | Replicas | vCPU | RAM |
|---|---|---|---|---|
| Development | t3.medium | 1 | 2 | 4 GB |
| Staging | t3.large | 1 | 2 | 8 GB |
| Production | t3.xlarge / c5.2xlarge | 2–3 | 4–8 | 16–32 GB |

### 11.2 Database

- **Engine**: PostgreSQL 15 (AWS RDS or self-managed)
- **Instance**: db.r6g.xlarge (production), db.t4g.medium (staging/dev)
- **Storage**: 500 GB gp3 (production), auto-scaling enabled
- **Backup**: Continuous WAL archiving, daily snapshots (30-day retention)
- **Multi-AZ**: Yes (production only)
- **Connection Pool**: PgBouncer (transaction pooling, 500 max connections)

### 11.3 Redis

- **Engine**: ElastiCache Redis 7 or self-managed
- **Instance**: cache.r6g.large (production)
- **Usage**: Bull queue, session cache, sanctions list cache, rate limiting
- **Key prefixing**: Per-vertical namespace (`immigration:`, `grc:`, `meru:`)

### 11.4 Storage

- **Provider**: AWS S3 (or S3-compatible)
- **Buckets**:
  - `meru-documents-{environment}` — Document files
  - `meru-config-packs-{environment}` — JSON config pack storage
  - `meru-audit-exports-{environment}` — Audit log exports
- **Encryption**: SSE-KMS with per-vertical keys
- **Lifecycle**: Glacier transition after 90 days (deleted), never delete (audit)

### 11.5 Networking

- **VPC**: Isolated per environment
- **Subnets**: Public (load balancers) + Private (app, database)
- **Security Groups**:
  - App → Database: Port 5432 only
  - App → Redis: Port 6379 only
  - App → S3: VPC Endpoint (no internet)
  - Load Balancer → App: Port 3000 only
  - External → Load Balancer: Port 443 only (TLS 1.3)

### 11.6 Monitoring

- **Metrics**: Prometheus (application + database + infrastructure)
- **Dashboards**: Grafana (enterprise dashboard pre-configured)
- **Alerting**: Grafana → PagerDuty/Slack
- **Logging**: Structured JSON logs → CloudWatch / Loki
- **Tracing**: OpenTelemetry → Grafana Tempo / Datadog APM

---

## 12. Security Requirements

### 12.1 Encryption Standards

| Data State | Standard | Key Management |
|---|---|---|
| In Transit | TLS 1.3 (mandatory) | AWS ACM / Let's Encrypt |
| At Rest (DB) | AES-256 (RDS encryption) | AWS KMS (auto-rotation: 90 days) |
| At Rest (S3) | AES-256-GCM (SSE-KMS) | Per-vertical KMS keys |
| Passwords | bcrypt (cost factor 12) | — |
| JWT Tokens | RS256 (RSA 2048-bit) | KMS or file-based key |
| Documents | AES-256-GCM | Per-vertical KMS keys |

### 12.2 Key Management

```
AWS KMS Key Hierarchy:
  └── meru-master-key (organization-level)
      ├── meru-immigration-key (vertical-level, rotation: 90d)
      ├── meru-grc-key (vertical-level, rotation: 90d)
      └── meru-platform-key (for meru core, rotation: 90d)

Data keys: Generated per document, encrypted with vertical key
Envelope encryption: Data key encrypts document, vertical key encrypts data key
```

### 12.3 Audit Requirements

- Every state-changing action MUST produce an audit log entry
- Audit log entries are hash-chained (SHA-256): each entry includes `previous_entry.hash`
- Logs are WORM (write-once-read-many): no update or delete on `audit_logs` table
- Hash chain verification runs weekly (automated job)
- Export format: CSV, JSON, PDF (summary report)
- Compliance standards tagged per entry: `gdpr`, `soc2`, `iso27001`, `aml`

### 12.4 Vulnerability Management

| Activity | Frequency | Tool |
|---|---|---|
| Container scanning | Every CI build | Trivy |
| Dependency audit | Weekly | `npm audit` + Dependabot |
| SAST (Static Analysis) | Every PR | ESLint security rules + SonarQube |
| DAST (Dynamic Analysis) | Monthly | OWASP ZAP |
| Penetration testing | Quarterly | External firm |
| Secret scanning | Pre-commit hook | git-secrets + GitHub secret scanning |

### 12.5 Incident Response

- **Severity Levels**: P1 (Critical — data breach) → P2 (High — service down) → P3 (Medium — feature broken) → P4 (Low — cosmetic)
- **Response Time**: P1: 15 min | P2: 30 min | P3: 4 hours | P4: 24 hours
- **Runbook**: Documented per module in `docs/runbooks/`
- **Post-mortem**: Required for all P1 and P2 incidents

---

## 13. Performance Budgets

### 13.1 API Response Time Budgets

| Endpoint Category | p50 | p95 | p99 |
|---|---|---|---|
| Auth (login, refresh) | < 50ms | < 200ms | < 500ms |
| CRUD (entities, cases, tasks) | < 50ms | < 150ms | < 300ms |
| Search (full-text) | < 100ms | < 300ms | < 500ms |
| Search (vector) | < 200ms | < 500ms | < 1s |
| AI (non-streaming) | < 2s | < 5s | < 10s |
| AI (streaming, first token) | < 2s | < 3s | < 5s |
| Document upload (10MB) | < 2s | < 5s | < 10s |
| Document download | < 500ms | < 2s | < 5s |
| Analytics (dashboard) | < 500ms | < 2s | < 5s |
| Sanctions screening (single) | < 100ms | < 200ms | < 500ms |
| Sanctions screening (batch 10k) | — | < 60s | < 120s |

### 13.2 Database Query Budgets

| Query Type | Target |
|---|---|
| Primary key lookup | < 5ms |
| Indexed column filter | < 20ms |
| Full-text search (tsvector) | < 100ms |
| JSONB query (GIN index) | < 50ms |
| JOIN (2-3 tables, indexed) | < 50ms |
| Aggregate query (dashboard) | < 500ms |
| Slow query threshold | > 100ms → logged and alerted |

### 13.3 Caching Strategy

| Data | Cache Store | TTL | Invalidation |
|---|---|---|---|
| Tenant settings | Redis | 5 minutes | On write |
| Sanctions lists | Redis (in-memory + disk) | 24 hours (sync cycle) | On sync complete |
| AI prompt templates | In-memory (service cache) | 1 hour | On upsert |
| User session | Redis | Access token TTL | On logout |
| Rate limit counters | Redis | Rolling window | Automatic expiry |
| Analytics results | Redis | 15 minutes | On report execution |

### 13.4 Frontend Performance Budgets

| Metric | Desktop | Mobile |
|---|---|---|
| LCP (Largest Contentful Paint) | < 2.5s | < 3.5s |
| FID (First Input Delay) | < 100ms | < 100ms |
| CLS (Cumulative Layout Shift) | < 0.1 | < 0.1 |
| TBT (Total Blocking Time) | < 200ms | < 300ms |
| JavaScript bundle size | < 200 KB (initial) | < 150 KB (initial) |
| Lighthouse Performance | > 90 | > 85 |

---

*This document specifies the technical requirements for the Meru RegOS platform. All implementations must meet or exceed the performance budgets in Section 13. All deployments must satisfy the security requirements in Section 12.*

*Last updated: 2026-05-31 — Phases A/B/C complete. Backend runs on PORT=8000. AU HomeAffairs + UAE Central Bank adapters active. `start:prod` script: `node dist/src/main`.*
