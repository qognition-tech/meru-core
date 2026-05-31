# Meru RegOS — System Architecture

> **Version**: 1.2 | **Status**: Phase A/B/C complete — active development
> **Owner**: Meru Platform Team | **Last Updated**: 2026-05-31
>
> This document is the **definitive technical architecture** for the Meru Regulatory Operating System.
> See also: [PRD.md](./PRD.md) · [TRD.md](./TRD.md) · [STRATEGY.md](./STRATEGY.md)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [The Four-Layer Config Injection Model](#2-the-four-layer-config-injection-model)
3. [Meru Core — The 14 Modules](#3-meru-core--the-14-modules)
4. [The 4 Specialist Engines](#4-the-4-specialist-engines)
5. [Multi-Tenancy Architecture](#5-multi-tenancy-architecture)
6. [Vertical Integration Pattern](#6-vertical-integration-pattern)
7. [Data Architecture](#7-data-architecture)
8. [Deployment Architecture](#8-deployment-architecture)
9. [Security Architecture](#9-security-architecture)
10. [AI Architecture](#10-ai-architecture)
11. [Technology Stack](#11-technology-stack)

---

## 1. System Overview

### 1.1 What Meru Is

Meru is a **Regulatory Operating System (RegOS)** — a horizontal platform that abstracts 80% of regulatory compliance plumbing and uses **JSON Configuration Packs** to handle the remaining 20% of vertical- and country-specific logic.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        MERU REGULATORY OS                             │
│                                                                       │
│  ┌────────────────┐   ┌────────────────┐   ┌──────────────────┐      │
│  │   PILLAR 1     │   │   PILLAR 2     │   │    PILLAR 3       │      │
│  │                │   │                │   │                   │      │
│  │  MERU CORE     │──▶│  IMMISTACK     │   │  GOVERNANCEX     │      │
│  │  (Engine)      │   │  (Immigration) │   │  (Banking GRC)   │      │
│  │                │   │                │   │                   │      │
│  │  14 Modules    │   │  Next.js 15    │   │  15 GRC Modules  │      │
│  │  4 Engines     │   │  4 Portals     │   │  150+ tRPC Routes│      │
│  │  JSON Packs    │   │  Kanban+Chat   │   │  216 DB Tables   │      │
│  └────────────────┘   └────────────────┘   └──────────────────┘      │
│         ▲                                                             │
│         │  Future: Health, Tax, Labour, Education (JSON config packs) │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 Domain Mapping & Environment Strategy

Every domain operates across **three environments** with strict data isolation:

| Domain | Prod | Staging | Dev | Purpose |
|---|---|---|---|---|
| `api.meru.com` | `api.meru.com` | `staging-api.meru.com` | `dev-api.meru.com` | Core RegOS Engine |
| `api.immistack.com` | `api.immistack.com` | `staging-api.immistack.com` | `dev-api.immistack.com` | Immigration Vertical API |
| `api.governancex.com` | `api.governancex.com` | `staging-api.governancex.com` | `dev-api.governancex.com` | Banking GRC Vertical API |
| `app.meru.com` | God UI | — | — | Platform Administration |
| `app.immistack.com` | Immigration UI | — | — | Firm/Staff/Client Portals |
| `app.governancex.com` | Banking UI | — | — | GRC Interface |

**Key principle**: The same Docker image is deployed 9 times (3 verticals × 3 environments), differentiated only by the `VERTICAL` and `NODE_ENV` environment variables. The vertical is **not** a separate codebase — it's a **configuration context** within the same engine.

### 1.3 How a Request Flows

```
Client (browser)
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  api.immistack.com                                   │
│  Host header parsed by TenantContextMiddleware       │
│  → vertical = "immigration"                          │
│  → environment = "production"                        │
│  → Sets PostgreSQL RLS context:                      │
│    SELECT app.set_context('immigration', 'production')│
└──────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  JWT Authentication (Passport + JwtStrategy)         │
│  Extracts: userId, tenantId, roles, vertical         │
└──────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  Policy Guard (RBAC + IP whitelist + business hours) │
│  Checks: user.roles ∩ requiredRoles ≠ ∅              │
└──────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  Module Controller → Service → TypeORM Repository    │
│  All queries auto-filtered by tenant_id (RLS)        │
└──────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  Audit: every mutation logged (hash-chained, WORM)   │
│  Response: { data, meta: { tenantId, requestId } }   │
└──────────────────────────────────────────────────────┘
```

**Current state**: This entire flow is implemented in `src/main.ts`, `src/iam/middleware/tenant-context.middleware.ts`, `src/iam/strategies/jwt.strategy.ts`, and `src/iam/guards/policy.guard.ts`. The RLS functions are defined in migration `1743860000000-AddRowLevelSecurity.ts`.

---

## 2. The Four-Layer Config Injection Model

This is the **architectural heart** of Meru. 80% of code is shared across all verticals; the remaining 20% is JSON.

```
┌──────────────────────────────────────────────────────────────┐
│ LAYER 4: VERTICAL LOGIC PACKS (JSON)                         │
│ ──────────────────────────────────────────────────────────── │
│ Immigration · Banking · Health · Tax · Labour · Education    │
│                                                              │
│ Each pack defines:                                           │
│  - Entity schemas (what fields does an "ImmigrationCase"     │
│    have that a generic "Case" doesn't?)                      │
│  - Workflow definitions (BPMN-like state machines)           │
│  - Form schemas (visa application, SAR filing, tax return)   │
│  - KPI dashboards                                            │
│  - AI prompt overrides                                       │
│  - Role definitions & permission matrices                    │
│  - Document checklists (visa-specific, compliance-specific)  │
│  - Communication templates (multi-lingual)                   │
└──────────────────────────────────────────────────────────────┘
                              ▲
┌──────────────────────────────────────────────────────────────┐
│ LAYER 3: COUNTRY OVERLAYS (JSON)                             │
│ ──────────────────────────────────────────────────────────── │
│ UAE · KSA · UK · CA · AU · NZ · US                           │
│                                                              │
│ Each country overlay adds:                                   │
│  - Regulator endpoints (MOHRE, Qiwa, HomeAffairs, IRCC...)  │
│  - Local compliance rules & data-residency requirements      │
│  - Currency, date formats, document types                    │
│  - Language packs (Arabic, English, French)                  │
│  - Country-specific form variants                            │
└──────────────────────────────────────────────────────────────┘
                              ▲
┌──────────────────────────────────────────────────────────────┐
│ LAYER 2: SPECIALIST ENGINES (shared code, ~10%)              │
│ ──────────────────────────────────────────────────────────── │
│ Regulatory Radar · Screening Engine · DocIntel · Vessel     │
│                                                              │
│ These engines provide cross-vertical "horizontal AI."        │
│ Each vertical can opt-in via feature flags in tenant config. │
└──────────────────────────────────────────────────────────────┘
                              ▲
┌──────────────────────────────────────────────────────────────┐
│ LAYER 1: 14 CORE MODULES (shared code, ~80%)                 │
│ ──────────────────────────────────────────────────────────── │
│ IAM · TCM · CRM · SRCH · AI · WF · FORM · TASK · COM · DOC  │
│ BILL · BI · AUD · INT                                        │
│                                                              │
│ Every module exposes:                                        │
│  - Versioned REST API (OpenAPI 3.0)                          │
│  - TypeORM entity with tenant_id + vertical + environment    │
│  - RLS policy at the database layer                          │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 How the Polymorphic Entity Pattern Works

The CRM module's `UniversalEntity` is the key enabler. Instead of creating separate tables for "Immigration Applicant" vs. "Bank Customer" vs. "Tax Payer", there is **one table** with a `verticalAttributes` JSONB column:

```typescript
// src/crm/entities/universal-entity.entity.ts
@Entity('universal_entities')
export class UniversalEntity {
  id: string;           // UUID
  tenantId: string;     // RLS isolation
  vertical: string;     // 'immigration' | 'grc' | 'labour' | ...
  environment: string;  // 'development' | 'staging' | 'production'
  type: EntityType;     // 'person' | 'organization'

  // Core fields (every vertical uses these)
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;

  // Vertical-specific fields injected as JSON
  // Immigration: { passportNumber, nationality, visaType, ... }
  // Banking:     { pepStatus, riskScore, kycStatus, ... }
  // Tax:         { vatNumber, taxResidency, ... }
  verticalAttributes: Record<string, any>;

  // Graph relationships (any entity can relate to any entity)
  relationships: Array<{ id: string; type: string }>;
}
```

**Current state**: Fully implemented. The `UniversalEntity` entity exists and is used by `CrmService`. The `verticalAttributes` column is JSONB with no schema enforcement at the DB layer — validation happens at the application layer via JSON Schema defined in the vertical config pack.

### 2.2 Config Pack Path Convention

```
packages/config-packs/
├── _schema/                    # JSON Schema validators for pack format
│   ├── vertical.schema.json
│   └── country.schema.json
├── au/                         # Australia
│   ├── immigration.json        # Student, PR, 485, tourist visas
│   └── tax.json                # GST, BAS, STP reporting
├── ae/                         # United Arab Emirates
│   ├── banking.json            # CBUAE compliance, AML/CFT
│   └── labour.json             # MOHRE work permits, WPS
├── ksa/                        # Saudi Arabia
│   ├── banking.json            # SAMA regulations
│   └── tax.json                # ZATCA e-invoicing
├── uk/
│   ├── immigration.json        # Skilled Worker, Student, Family
│   ├── banking.json            # FCA/PRA compliance
│   └── tax.json                # MTD VAT, Corporation Tax
└── ca/
    ├── immigration.json        # Express Entry, PNP, Study Permit
    └── tax.json                # CRA reporting
```

**Current state**: Implemented. Config packs are on disk under `packages/config-packs/`. The `ConfigPackLoaderService` auto-seeds packs at boot. Active packs: `au/immigration.json`, `ae/banking.json`. The `_schema/` directory contains `config-pack.schema.json` (JSON Schema) and `pack.schema.ts` (Zod). Additional skeleton directories exist for `ksa/`, `uk/`, and `ca/`.

---

## 3. Meru Core — The 14 Modules

Every module follows the same NestJS pattern: `Module → Controller → Service → Entity (TypeORM)`. All modules are independently deployable in the target state; currently they run as a single NestJS monolith.

### Module Map

| # | Code | Module | DB Tables | Status | Key API Endpoints |
|---|---|---|---|---|---|
| 1 | **IAM** | Identity & Access | `users`, `tenants` | Implemented | `POST /auth/login`, `POST /auth/register`, `GET /auth/profile` |
| 2 | **TCM** | Tenant Config Management | `tenant_settings` | Implemented | `GET/PATCH /tenants/:id` |
| 3 | **CRM** | Universal Entity Manager | `universal_entities` | Implemented | `GET/POST /crm/entities` |
| 4 | **SRCH** | Universal Search | `search_index` | Implemented | Full-text + vector search |
| 5 | **AI** | AI Orchestration Gateway | `ai_prompts`, `ai_embeddings` | Implemented | `POST /ai/execute`, `POST /ai/embeddings`, `GET /ai/search` |
| 6 | **WF** | Workflow & State Machine | `workflows`, `workflow_states`, `workflow_transitions`, `workflow_instances` | Implemented | CRUD workflows, start/transition instances |
| 7 | **FORM** | Dynamic Form Builder | `form_schemas`, `form_fields`, `form_submissions` | Implemented | CRUD forms, submit/validate |
| 8 | **TASK** | Task & Activity Manager | `tasks`, `task_comments`, `recurring_jobs` | Implemented | CRUD tasks, comments |
| 9 | **COM** | Communication Hub | `notifications`, `notification_preferences`, `notification_templates` | Implemented | Multi-channel (email, SMS, push) |
| 10 | **DOC** | Document Manager | `documents`, `document_versions`, `document_metadata` | Implemented | Upload, versioning, S3 abstraction |
| 11 | **BILL** | Billing & Metering | `billing_plans`, `subscriptions`, `usage_records`, `invoices`, `invoice_items`, `credit_ledger` | Implemented | Plans, subscriptions, usage, invoicing |
| 12 | **BI** | Analytics & BI Engine | `reports`, `report_executions`, `dashboard_widgets` | Implemented | Reports, dashboards, exports |
| 13 | **AUD** | Audit & Compliance Logger | `audit_logs` | Implemented | Tamper-evident, WORM, hash-chained |
| 14 | **INT** | Integration Hub | *(uses queue, storage modules)* | Partially | Government API adapters |

### 3.1 IAM — Identity & Access Management

**Purpose**: OAuth2/OIDC authentication, RBAC/ABAC authorization, MFA, SAML SSO, session brokering.

**Architecture**:
```
src/iam/
├── iam.controller.ts              # POST /auth/login, /auth/register, GET /auth/profile
├── iam.service.ts                 # bcrypt hashing, JWT signing, user lookup
├── tenant-provisioning.controller.ts  # POST /tenants/provision
├── tenant-provisioning.service.ts     # Atomic tenant+admin user creation
├── entities/
│   ├── user.entity.ts             # users table (id, tenantId, email, password, roles[], attributes)
│   └── tenant.entity.ts           # tenants table (id, slug, name, vertical, status, plan, settings)
├── strategies/
│   ├── jwt.strategy.ts            # Bearer token extraction & validation
│   ├── local.strategy.ts          # Email+password validation
│   └── saml.strategy.ts           # SAML SSO with JIT provisioning
├── guards/
│   ├── jwt-auth.guard.ts          # Route protection
│   └── policy.guard.ts            # RBAC + IP whitelist + business hours
├── middleware/
│   └── tenant-context.middleware.ts  # Domain→vertical/env resolution + RLS
├── decorators/
│   ├── current-user.decorator.ts  # @CurrentUser() param decorator
│   └── roles.decorator.ts         # @Roles('admin') metadata
└── enums/
    ├── auth-provider.enum.ts      # local, saml, oidc
    └── vertical.enum.ts           # immigration, grc, labour, fintech, legal
```

**JWT Payload Structure**:
```typescript
interface JwtPayload {
  sub: string;        // User UUID
  email: string;
  tenantId: string;
  tenantSlug: string;
  vertical: string;   // 'immigration' | 'grc' | 'labour' | ...
  environment: string;
  roles: string[];    // ['admin', 'staff'] or ['client']
  iat: number;
  exp: number;
}
```

**Role Hierarchy**:
```
platform_admin       → Global platform access (God View)
  └─ firm_admin      → Full tenant admin (billing, staff, branding, settings)
       └─ senior_agent → Case management + limited admin
            └─ agent  → Case processing, documents, communications
                 └─ client → Self-service portal only
```

**Current state**: Fully implemented. JWT, local, and SAML strategies are operational. RBAC guard works with `@Roles()` decorator. Tenant provisioning creates both tenant + admin user atomically.

### 3.2 TCM — Tenant Config & Settings

**Purpose**: Stores and validates vertical configuration packs per tenant. The bridge between JSON packs and runtime behavior.

**Entity**: `tenant_settings` (id, tenantId, config JSONB, createdAt, updatedAt)

**Config Structure** (stored in `tenant_settings.config`):
```json
{
  "vertical": "immigration",
  "version": "1.2.0",
  "modules": {
    "crm": { "enabled": true },
    "documents": { "enabled": true, "storageProvider": "s3" },
    "ai": { "enabled": true, "provider": "openai" }
  },
  "workflows": {
    "case_management": {
      "stages": ["lead", "consultation", "signed_up", "documents_pending", ...],
      "transitions": [...]
    }
  },
  "forms": {
    "visa_application_482": { "schema": {...}, "fields": [...] }
  },
  "branding": {
    "logo": "s3://tenant-123/brand/logo.png",
    "colors": { "primary": "#1E3A5F", "secondary": "#64748B" }
  }
}
```

### 3.3 CRM — Universal Entity Manager

**Purpose**: Polymorphic entity storage — Person, Organization, Case, Asset — all in one table with vertical-specific JSONB injection.

**API**:
- `POST /api/v1/crm/entities` — Create entity (with verticalAttributes validated against schema)
- `GET /api/v1/crm/entities` — List entities (filtered by type, vertical, tenant)
- `GET /api/v1/crm/entities/:id` — Get single entity with relationships
- `PATCH /api/v1/crm/entities/:id` — Update entity (partial, merges verticalAttributes)
- `DELETE /api/v1/crm/entities/:id` — Soft delete

**Relationship Model**: Entities form a graph via the `relationships` JSONB column:
```json
[
  { "id": "uuid-456", "type": "EMPLOYEE_OF" },
  { "id": "uuid-789", "type": "HAS_CASE" },
  { "id": "uuid-012", "type": "CONTACT_FOR" }
]
```

### 3.4 SRCH — Universal Search

**Purpose**: Elasticsearch + PostgreSQL full-text + vector embeddings for hybrid search.

**Architecture**: Two-tier search:
1. **PostgreSQL full-text** (`tsvector` on `search_index.content`) for structured queries and filtering
2. **pgvector/Elasticsearch** for semantic/vector search via the AI module's embedding pipeline
3. **Elasticsearch** for advanced full-text, faceting, and suggestions (optional, configurable)

**Current state**: PostgreSQL full-text search is implemented via `search_index` table and `SearchService`. Elasticsearch integration is scaffolded in `src/elasticsearch/`. Vector search is implemented in `AiService.semanticSearch()` using OpenAI embeddings + cosine similarity.

### 3.5 AI — AI Orchestration Gateway

See [Section 10 — AI Architecture](#10-ai-architecture) for the full deep dive.

### 3.6 WF — Workflow & State Machine

**Purpose**: BPMN-like process engine for case management, compliance workflows, and SLA tracking.

**Entity Model**:
```
Workflow (definition)
  ├── WorkflowState[] (stages)
  ├── WorkflowTransition[] (edges with conditions)
  └── WorkflowInstance[] (running instances)
        ├── current_state_id
        ├── context (JSONB) — case data snapshot
        ├── history[] — state change log
        ├── sla_deadline
        ├── escalation_level
        └── sla_violations[]
```

**SLA Watchdog**: A scheduled job (`SlaWatchdogService`) runs every 60 seconds, checks all active instances for SLA breaches, increments escalation levels, and fires notifications.

**Example — Immigration Case Workflow**:
```
Lead → Consultation Booked → Signed Up → Documents Pending
  → Application Draft → Client Review → Submitted
  → Additional Info (gov request) → Granted/Refused
```

**Current state**: Implemented. Entities, service, controller, and SLA watchdog are functional.

### 3.7 FORM — Dynamic Form Builder

**Purpose**: JSON Schema-driven forms rendered by the frontend. Each vertical defines its forms in the config pack.

**Entity Model**:
```
FormSchema (definition)
  ├── FormField[] (field definitions with types, validation, conditions)
  └── FormSubmission[] (submitted data)
```

**Key feature**: Fields can be conditionally shown/hidden based on other field values or vertical context. For example, "Health Insurance" fields appear only for Student/485 visa types in immigration.

### 3.8 TASK — Task & Activity Manager

**Purpose**: Assignments, deadlines, dependencies, reminders. Used by every vertical for case work items, compliance checklists, and staff workflows.

**Entity**: `tasks` (id, tenantId, case_id, assigned_to, title, description, status, priority, due_date, type, tags)

### 3.9 COM — Communication Hub

**Purpose**: Multi-channel messaging — Email, WhatsApp, SMS, Push Notifications — with template management and multi-language support.

**Entity Model**:
```
Notification (sent message log)
```

> Note: `NotificationTemplate` and `NotificationPreference` entities were removed during Phase A cleanup (dead code). Template and preference logic is handled via JSONB on the Notification entity and tenant settings.

### 3.10 DOC — Document Manager

**Purpose**: S3-abstraction document storage with versioning, OCR, encryption, and RBAC.

**Entity Model**:
```
Document
  ├── DocumentVersion[] (version history, each with S3 key, checksum, encryption metadata)
  └── DocumentMetadata (extracted data, AI analysis results, tags)
```

**RBAC Model**: Each document has an `rbac` JSONB field:
```json
{
  "owner": "user-uuid",
  "roles": ["admin", "senior_agent"],
  "permissions": {
    "read": ["agent", "client"],
    "write": ["admin", "senior_agent"],
    "delete": ["admin"]
  }
}
```

**Current state**: Implemented. `DocumentsService` handles S3 upload/download, `DocumentHubService` provides cross-module document attachment, and `DocumentAuthGuard` enforces RBAC.

### 3.11 BILL — Billing & Metering

**Purpose**: Subscription management, usage-based billing, invoicing, credit ledger. Support for Stripe integration.

**Entity Model**:
```
BillingPlan → Subscription → UsageRecord[]
                           → Invoice → InvoiceItem[]
                           → CreditLedger[]
```

**Pricing Model Support**:
- Per-seat (staff count)
- Per-case (immigration)
- Per-scan (sanctions screening)
- Per-API-call (integration hub)
- Flat monthly (platform fee)

### 3.12 BI — Analytics & BI Engine

**Purpose**: Embedded dashboards, KPI posture scoring, scheduled reports, CSV/PDF export.

**Entity Model**:
```
Report (definition — data source, filters, schedule)
  └── ReportExecution (cached result)
DashboardWidget (individual widget on a dashboard)
```

### 3.13 AUD — Audit & Compliance Logger

**Purpose**: Tamper-evident, hash-chained, WORM (write-once-read-many) audit logs for every state-changing action.

**Tamper-Evident Chain Algorithm**:
```
audit_log_{n}.hash = SHA-256(
  audit_log_{n}.action +
  audit_log_{n}.entity_id +
  audit_log_{n}.tenant_id +
  audit_log_{n}.timestamp +
  audit_log_{n-1}.hash  // Chain to previous entry
)
```

**Current state**: Implemented. `AuditService` logs all state-changing actions. The hash chain and compliance standard tagging are functional.

### 3.14 INT — Integration Hub

**Purpose**: Government API adapters — MOHRE, Qiwa, HomeAffairs, IRCC, CBUAE, Finacle, World-Check, Dow Jones.

**Architecture**: Each integration is a plugin implementing a standard interface:
```typescript
interface GovernmentAdapter {
  name: string;
  country: CountryCode;
  vertical: VerticalType;
  authenticate(): Promise<AuthToken>;
  syncData(since: Date): AsyncIterator<Record>;
  pushData(data: Record): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
}
```

**Current state**: Two adapters active — `src/integrations/adapters/au-home-affairs.adapter.ts` (AU Department of Home Affairs) and `src/integrations/adapters/uae-central-bank.adapter.ts` (CBUAE). Both implement the `GovernmentAdapter` interface. Queue, storage, and Elasticsearch infrastructure also in place.

---

## 4. The 4 Specialist Engines

These engines sit **alongside** the 14 core modules and provide cross-vertical "horizontal AI." Each vertical can opt in via tenant settings.

### 4.1 Regulatory Radar 🛰️

**What**: Autonomous AI agents that continuously crawl official government sources.

**Data Flow**:
```
Crawl Scheduler (every 6 hours)
  → Government Gazette Scrapers (per country, per regulator)
    → Diff Detection (embedding comparison against previous crawl)
      → Rule Change Detection (LLM with citation enforcement)
        → Auto-draft Config Pack Diff (Git-based PR)
          → Human Review Queue (God View UI)
            → Approved → Merge into config pack → Notify affected tenants
```

**Sources Tracked**:
- UAE: MOHRE, DED, CBUAE, ICP, DHA
- KSA: Qiwa, SAMA, ZATCA, MISA
- UK: Home Office, FCA, HMRC, Companies House
- AU: HomeAffairs, ASIC, ATO, APRA
- CA: IRCC, FINTRAC, CRA, OSFI

**Performance Target**: Rule change → draft pack diff in ≤ 24 hours.

### 4.2 Screening Engine 🎯

**What**: High-performance fuzzy-logic matching for Sanctions, PEP, Adverse Media screening.

**Algorithm Pipeline**:
```
Input Name
  → Transliteration Normalization (Arabic ↔ Latin, Cyrillic ↔ Latin)
  → Name Tokenization
  → Multi-Algorithm Scoring:
      ├── Levenshtein Distance (edit-based)
      ├── Jaro-Winkler (phonetic similarity)
      ├── Soundex (phonetic encoding)
      ├── N-gram Overlap (substring matching)
      └── Embedding Cosine Similarity (semantic)
  → Weighted Ensemble Score
  → Threshold-based Flagging (configurable per risk appetite)
  → Results → Audit Log
```

**Sanctions Lists** (auto-synced every 24h):
- OFAC (US)
- EU Consolidated List
- UN Security Council
- UK HMT Sanctions
- UAE Local Terrorist List
- Client Custom Watchlists

**Performance Targets**:
- Single name: sub-200ms p95
- Batch mode: >10,000 names/min
- False positive rate: <5%

**Current state**: Implemented in Meru Core. The fuzzy-match engine (Jaro-Winkler, Levenshtein, Soundex, transliteration) is wired into the AI specialist engines layer in `src/ai/engines/`.

### 4.3 Document Intelligence Layer 📄

**What**: Advanced AI for OCR, structured-data extraction, and fraud detection.

**Capabilities**:
- Multi-language OCR (Arabic, English, Urdu, Tagalog, Hindi)
- Layout-aware extraction (passports, payslips, bank statements, contracts)
- Fraud signals: EXIF anomalies, font inconsistencies, metadata tampering, duplicate detection across tenants (privacy-preserving via hash comparison)
- Automated document classification (passport vs. bank statement vs. utility bill)

**Fraud Detection Pipeline**:
```
Uploaded Document
  → EXIF/Metadata Analysis
  → Visual Tampering Detection (ELA — Error Level Analysis)
  → Font Consistency Check
  → Cross-Tenant Duplicate Check (perceptual hash, privacy-preserved)
  → AI Classification
  → Risk Score (0-100)
```

### 4.4 Vessel / Asset Tracking Engine 🚢

**What**: Real-time AIS data integration + geofencing for trade finance and supply chain compliance.

**Data Sources**: AIS feeds, port call logs, IMO vessel registry, sanctioned-port geofences.

**Risk Signals**:
- Port call at sanctioned location
- AIS transmission gap > 12 hours (dark fleet detection)
- Ship-to-ship transfer in high-risk zone
- Ownership chain linking to sanctioned entity
- Route deviation from filed bill of lading

**Output**: Vessel risk score (0-100), port-call timeline, sanctioned-route alert, ownership graph.

**Primary consumer**: GovernanceX (Trade Finance module).

---

## 5. Multi-Tenancy Architecture

Tenant isolation is implemented at **three layers** — defense in depth.

### 5.1 Layer 1: Database — Row-Level Security (RLS)

Every table includes `tenant_id`, `vertical`, and `environment` columns. PostgreSQL RLS policies enforce that queries can never cross tenant/vertical/environment boundaries.

```sql
-- Migration 1743860000000-AddRowLevelSecurity.ts
CREATE FUNCTION app.set_context(p_vertical TEXT, p_environment TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.current_vertical', p_vertical, false);
  PERFORM set_config('app.current_environment', p_environment, false);
END; $$;

-- Every table policy:
CREATE POLICY tenant_isolation ON universal_entities
  FOR ALL
  USING (vertical = current_setting('app.current_vertical')
     AND environment = current_setting('app.current_environment'));
```

### 5.2 Layer 2: Application — Domain-Based Routing

`TenantContextMiddleware` (src/iam/middleware/tenant-context.middleware.ts) parses the `Host` header:

| Host Pattern | Vertical | Environment |
|---|---|---|
| `api.immistack.com` | immigration | production |
| `staging-api.immistack.com` | immigration | staging |
| `dev-api.immistack.com` | immigration | development |
| `api.governancex.com` | grc | production |
| `api.meru.com` | meru (platform) | production |

The middleware calls `app.set_context(vertical, environment)` before every request, which sets PostgreSQL session variables that RLS policies read.

### 5.3 Layer 3: Infrastructure — Per-Vertical Networks

Each vertical runs on its own Docker network (`meru-network`, `immigration-network`, `grc-network`). In the Kubernetes target state, each vertical gets its own namespace with network policies.

### 5.4 Storage Isolation

S3 storage is bucketed/prefixed per tenant with separate KMS keys for regulated data:
```
s3://meru-documents/
  └── {vertical}/
      └── {tenant_id}/
          └── {document_uuid}/
              ├── v1.pdf        (AES-256-GCM, KMS key per regulated vertical)
              └── v2.pdf
```

---

## 6. Vertical Integration Pattern

### 6.1 How a Vertical App Connects to Meru Core

Using ImmiStack as the reference implementation:

```
┌─────────────────────────────────────────────────────────────────┐
│  IMMISTACK FRONTEND (Next.js 15)                                 │
│  lib/api/client.ts — Axios instance                              │
│                                                                  │
│  Every request:                                                  │
│    Authorization: Bearer <jwt>                                   │
│    X-Tenant-ID: <tenant_uuid>                                    │
│    Content-Type: application/json                                │
│                                                                  │
│  Token Lifecycle:                                                │
│    1. POST /api/v1/auth/login → { accessToken, refreshToken }    │
│    2. Store in memory (SSR-safe) + localStorage                  │
│    3. Axios interceptor: inject JWT + X-Tenant-ID                │
│    4. On 401: enqueue failed request, refresh token, replay      │
│    5. On refresh failure: redirect to /login                     │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  MERU CORE API (NestJS 11)                                       │
│                                                                  │
│  TenantContextMiddleware:                                        │
│    api.immistack.com → vertical=immigration, env=production      │
│                                                                  │
│  JwtStrategy:                                                    │
│    Extract Bearer token → validate → attach user to request      │
│                                                                  │
│  PolicyGuard:                                                    │
│    @Roles('admin') → check user.roles ∩ ['admin'] ≠ ∅            │
│                                                                  │
│  Module Controller:                                              │
│    @Get('/api/v1/cases') → CrmService.findAll(tenantId, ...)     │
│                                                                  │
│  TypeORM:                                                        │
│    SELECT * FROM universal_entities                              │
│    WHERE tenant_id = $1  -- AND RLS auto-filters vertical+env    │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Adding a New Vertical (Target State)

1. **Define the vertical** in `src/iam/enums/vertical.enum.ts` (e.g., `TAX = 'tax'`)
2. **Author the JSON pack** at `packages/config-packs/{country}/{vertical}.json`:
   - Entity field definitions
   - Workflow definitions
   - Form schemas
   - Role definitions
   - KPI dashboards
   - Document checklists
3. **Build the vertical UI** using Next.js 15 + shadcn/ui (2-6 weeks per vertical)
4. **Register in God View** (`app.meru.com`) — version-pin to tenants
5. **Deploy** — the same Docker image picks up the new vertical via `VERTICAL=tax` env var

**Time to launch a new vertical: ≤ 6 weeks**
**Time to onboard a new country: ≤ 3 weeks**

---

## 7. Data Architecture

### 7.1 Complete Entity Relationship Diagram (Simplified)

```
┌──────────┐     ┌───────────────┐     ┌─────────────────────┐
│ tenants  │────→│ tenant_settings│     │ universal_entities   │
│          │     │               │     │  - tenantId          │
│ id (PK)  │     │ config (JSONB)│     │  - vertical          │
│ slug     │     │ vertical      │     │  - type (person/org) │
│ vertical │     │ environment   │     │  - verticalAttrs    │
│ status   │     └───────────────┘     │  - relationships     │
│ plan     │                           └──────────┬───────────┘
│ settings │                                      │
└─────┬────┘                           ┌──────────┴───────────┐
      │                                │                      │
      ▼                                ▼                      ▼
┌──────────┐     ┌──────────────┐  ┌────────────────┐  ┌──────────┐
│  users   │     │ workflow_    │  │   documents    │  │  tasks   │
│          │     │ instances    │  │                │  │          │
│ tenantId │     │ entity_id→  │  │ linkedEntityId │  │ case_id  │
│ roles[]  │     │ current_    │  │ linkedEntityType│  │ assigned │
│ email    │     │ state_id    │  │ s3Url         │  │ _to      │
└──────────┘     └──────────────┘  └────────────────┘  └──────────┘
```

Every table in the system has these standard columns:
- `id` (UUID, PK)
- `tenant_id` (FK → tenants)
- `vertical` (enum: immigration, grc, labour, fintech, legal)
- `environment` (enum: development, staging, production)
- `created_at` (timestamp)
- `updated_at` (timestamp, where applicable)

### 7.2 Complete Table Inventory

| # | Table | Module | Key Columns | RLS |
|---|---|---|---|---|
| 1 | `tenants` | IAM | slug, name, vertical, status, plan, settings (JSONB), ssoConfig (JSONB) | Yes |
| 2 | `users` | IAM | tenantId, email, password, provider, roles[], attributes (JSONB) | Yes |
| 3 | `tenant_settings` | TCM | tenantId, config (JSONB) | Yes |
| 4 | `universal_entities` | CRM | tenantId, type, firstName, lastName, email, phone, verticalAttributes (JSONB), relationships (JSONB) | Yes |
| 5 | `search_index` | SRCH | tenantId, searchableType, searchableId, title, content, vector (tsvector) | Yes |
| 6 | `ai_prompts` | AI | tenantId, category, key, prompt, preferredProvider, modelConfig (JSONB) | Yes |
| 7 | `ai_embeddings` | AI | tenantId, vectorId, type, resourceId, vector (JSONB) | Yes |
| 8 | `workflows` | WF | tenantId, name, entity_type, status, trigger, trigger_config, sla_config | Yes |
| 9 | `workflow_states` | WF | workflow_id, name, type, config (JSONB) | Inherited |
| 10 | `workflow_transitions` | WF | workflow_id, from_state_id, to_state_id, conditions (JSONB), actions (JSONB) | Inherited |
| 11 | `workflow_instances` | WF | tenantId, workflow_id, entity_id, current_state_id, status, context (JSONB), history (JSONB), sla_deadline | Yes |
| 12 | `form_schemas` | FORM | tenantId, name, entity_type, schema (JSONB) | Yes |
| 13 | `form_fields` | FORM | schema_id, name, type, config (JSONB), validation (JSONB) | Inherited |
| 14 | `form_submissions` | FORM | tenantId, schema_id, entity_id, data (JSONB), status | Yes |
| 15 | `tasks` | TASK | tenantId, case_id, assigned_to, title, status, priority, due_date, type | Yes |
| 16 | `task_comments` | TASK | task_id, author_id, content | Inherited |
| 17 | `recurring_jobs` | TASK | tenantId, name, cron, task_template (JSONB) | Yes |
| 18 | `documents` | DOC | tenantId, name, fileType, status, encryption, linkedEntityType, s3Url, rbac (JSONB), aiAnalysis (JSONB) | Yes |
| 19 | `document_versions` | DOC | document_id, s3Key, s3Bucket, checksum, encryptionKey, encryptionAlgorithm | Inherited |
| 20 | `document_metadata` | DOC | document_id, type, data (JSONB), extractedBy | Inherited |
| 21 | `billing_plans` | BILL | name, price, currency, interval, features (JSONB) | No (shared) |
| 22 | `subscriptions` | BILL | tenantId, plan_id, status, currentPeriodStart, currentPeriodEnd | Yes |
| 23 | `usage_records` | BILL | tenantId, subscription_id, metric, quantity, timestamp | Yes |
| 24 | `credit_ledger` | BILL | tenantId, amount, type, description, balance_after | Yes |
| 25 | `invoices` | BILL | tenantId, subscription_id, amount, currency, status, due_date, paid_at | Yes |
| 26 | `invoice_items` | BILL | invoice_id, description, quantity, unit_price, amount | Inherited |
| 27 | `reports` | BI | tenantId, name, dataSource, filters (JSONB), schedule (JSONB) | Yes |
| 28 | `report_executions` | BI | report_id, status, result (JSONB), startedAt, completedAt | Inherited |
| 29 | `dashboard_widgets` | BI | tenantId, report_id, type, config (JSONB), position | Yes |
| 30 | `audit_logs` | AUD | tenantId, action, entityType, entityId, userId, changes (JSONB), hash, previous_hash, complianceStandard | Yes |
| 31 | `notifications` | COM | tenantId, userId, channel, template_id, content, status, sentAt | Yes |
| 32 | `notification_preferences` | COM | *(entity deleted in Phase A — preferences stored in tenant settings JSONB)* | — |
| 33 | `notification_templates` | COM | *(entity deleted in Phase A — templates stored in config pack JSON)* | — |
| 34 | `storage_files` | STORAGE | tenantId, originalName, mimeType, size, s3Key, s3Bucket, status | Yes |
| 35 | `storage_file_versions` | STORAGE | file_id, versionNumber, s3Key, size, checksum | Inherited |
| 36 | `storage_multipart_uploads` | STORAGE | tenantId, fileKey, uploadId, parts (JSONB), status | Yes |
| 37 | `queue_jobs` | QUEUE | tenantId, name, data (JSONB), status, priority, attempts, scheduledAt | Yes |
| 38 | `queue_job_logs` | QUEUE | job_id, status, message, duration | Inherited |
| 39 | `queue_workers` | QUEUE | name, status, lastHeartbeat, queue | No |
| 40 | `queue_scheduled_jobs` | QUEUE | tenantId, name, cron, job_template (JSONB), enabled | Yes |
| 41 | `elasticsearch_indices` | ES | tenantId, name, settings (JSONB), mappings (JSONB), status | Yes |
| 42 | `elasticsearch_documents` | ES | index_id, documentId, body (JSONB) | Inherited |
| 43 | `elasticsearch_search_logs` | ES | tenantId, query, filters (JSONB), resultCount, duration | Yes |

---

## 8. Deployment Architecture

### 8.1 Current: Docker Compose (Single Server)

The same Docker image is deployed as 9 containers + monitoring:

```
┌─────────────────────────────────────────────────────────────┐
│  EC2 Instance / VPS                                         │
│                                                             │
│  ┌──────────┐ ┌──────────────┐ ┌──────────┐               │
│  │ meru     │ │ immigration  │ │ grc      │               │
│  │ :3000 P  │ │ :3003 P      │ │ :3006 P  │               │
│  │ :3001 S  │ │ :3004 S      │ │ :3007 S  │               │
│  │ :3002 D  │ │ :3005 D      │ │ :3008 D  │               │
│  └──────────┘ └──────────────┘ └──────────┘               │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │ Prometheus :9090 │  │ Grafana :3009    │                │
│  └──────────────────┘  └──────────────────┘                │
│                                                             │
│  All containers share:                                      │
│   - RDS PostgreSQL (per-vertical database)                  │
│   - ElastiCache Redis (shared, key-prefixed per vertical)   │
│   - S3 (per-tenant prefix, per-vertical bucket)             │
└─────────────────────────────────────────────────────────────┘
```

### 8.2 Target: Kubernetes (Multi-Region)

```
┌────────────────────────────────────────────────────────────┐
│  AWS EKS / GKE — Region: me-central-1 (UAE)                │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │ Namespace: meru  │  │ Namespace: immi  │  ...           │
│  │                  │  │                  │                │
│  │ Deployment:      │  │ Deployment:      │                │
│  │  meru-api-prod   │  │  immi-api-prod   │                │
│  │  (3 replicas)    │  │  (2 replicas)    │                │
│  │                  │  │                  │                │
│  │ Service:         │  │ Service:         │                │
│  │  ClusterIP:3000  │  │  ClusterIP:3000  │                │
│  │                  │  │                  │                │
│  │ NetworkPolicy:   │  │ NetworkPolicy:   │                │
│  │  deny-from-other │  │  deny-from-other │                │
│  └──────────────────┘  └──────────────────┘                │
│                                                             │
│  ┌──────────────────────────────────────────┐              │
│  │ Ingress (Nginx / AWS ALB)                │              │
│  │  api.immistack.com → immi-api-prod:3000  │              │
│  │  api.governancex.com → grc-api-prod:3000 │              │
│  │  api.meru.com → meru-api-prod:3000       │              │
│  └──────────────────────────────────────────┘              │
└────────────────────────────────────────────────────────────┘
```

### 8.3 CI/CD Pipeline

```
Git Push → GitHub Actions
  ├── ci.yml: Build → Lint → Test → Security Scan (Trivy) → Docker Build
  └── deploy.yml (on merge to main/staging/dev):
        ├── Build Docker image
        ├── Push to ECR
        ├── Run DB migrations (per environment)
        ├── Deploy to EC2 (pm2) / EKS (kubectl)
        └── Health check + rollback on failure
```

---

## 9. Security Architecture

### 9.1 Authentication Flow

```
┌─────────┐     ┌──────────────┐     ┌─────────────┐
│ Client  │────▶│ POST /auth/  │────▶│ IamService   │
│         │     │ login        │     │              │
│         │     │ {email, pwd} │     │ bcrypt.      │
│         │     │              │     │ compare()    │
│         │     └──────────────┘     │              │
│         │                          │ Generate     │
│         │     ┌──────────────┐     │ JWT (RS256)  │
│         │◀────│ { accessToken,│◀────│              │
│         │     │   refreshToken}│    └─────────────┘
│         │     └──────────────┘
│         │
│         │     ┌──────────────┐     ┌─────────────┐
│         │────▶│ GET /cases   │────▶│ JwtStrategy  │
│         │     │ Authorization│     │ verify() +   │
│         │     │ Bearer <jwt> │     │ attach user  │
│         │     └──────────────┘     └─────────────┘
└─────────┘
```

### 9.2 Authorization Model

**RBAC** (Role-Based Access Control):
- Roles stored as string array on User entity: `['admin', 'staff']`
- `@Roles('admin')` decorator on controllers
- `PolicyGuard` checks `user.roles ∩ requiredRoles ≠ ∅`
- Plus: IP whitelist check, business hours restriction (configurable per tenant)

**ABAC** (Attribute-Based Access Control):
- `User.attributes` JSONB column stores department, clearance level, country access
- `PolicyGuard` evaluates attribute-based rules from tenant settings
- Example: "Only staff with `country_access: ['AU']` can view Australian cases"

### 9.3 Document Encryption

- **At Rest**: AES-256-GCM with per-vertical KMS keys
- **In Transit**: TLS 1.3 (enforced by Helmet middleware)
- **Key Management**: AWS KMS with automatic key rotation (90 days)
- **Regulated Data**: Separate KMS keys for immigration, banking, and health verticals (data residency compliance)

### 9.4 Audit Chain Integrity

Every audit log entry is hash-chained:
```
Entry N: {
  action, entity_id, tenant_id, timestamp,
  hash: SHA-256(action + entity_id + tenant_id + timestamp + previous_hash)
}
```

Tampering with any entry invalidates all subsequent hashes. Logs are stored WORM (write-once-read-many) and exportable in regulator-friendly formats (CSV, JSON, PDF).

---

## 10. AI Architecture

### 10.1 Model-Agnostic Gateway

The AI module (`src/ai/`) is a **gateway**, not a model. It routes requests to the appropriate provider based on prompt configuration:

```typescript
// src/ai/entities/ai-prompt.entity.ts
export enum ModelProvider {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  LOCAL = 'local',    // Self-hosted models
  AZURE = 'azure',    // Azure OpenAI
}

export enum PromptCategory {
  ENTITY_ANALYSIS = 'entity_analysis',
  DATA_EXTRACTION = 'data_extraction',
  VALIDATION = 'validation',
  WORKFLOW_DECISION = 'workflow_decision',
  DOCUMENT_ANALYSIS = 'document_analysis',
  COMPLIANCE_ANALYSIS = 'compliance_analysis',
  PREDICTIVE_ANALYTICS = 'predictive_analytics',
  DATA_ANALYSIS = 'data_analysis',
  CROSS_MODULE_ANALYSIS = 'cross_module_analysis',
}
```

### 10.2 RAG with Citation Enforcement

For regulatory answers, the AI module MUST include inline citations:

```
User: "What are the document requirements for a 482 visa?"

AI Response:
"Based on the Department of Home Affairs guidelines (accessed 2026-05-28):

1. Valid passport [Source: immi.homeaffairs.gov.au/visas/482/checklists]
2. Skills assessment from relevant authority [Source: immi.homeaffairs.gov.au/visas/482/skills]
3. English language test results [Source: immi.homeaffairs.gov.au/visas/482/english]
..."

⚠️ If no verified source is found, the response is SUPPRESSED:
"I don't have a verified source for this. Please consult the official
Department of Home Affairs website or contact your case officer."
```

**Enforcement mechanism**: The AI service checks each generated response for citation markers (`[Source: ...]`). If citations are missing and the category is `COMPLIANCE_ANALYSIS`, the response is blocked and replaced with the fallback message.

### 10.3 Cross-Module AI Orchestration

The AI service (`AiService`) is injected with 8 other services, enabling cross-module AI:

```
AiService
  ├── CrmService          → AI entity analysis, smart search
  ├── WorkflowEngineService → AI workflow recommendation
  ├── TaskService         → AI task prioritization
  ├── FormBuilderService  → AI form validation
  ├── DocumentsService    → AI document classification, OCR extraction
  ├── BillingService      → AI billing anomaly detection
  ├── AnalyticsService    → AI predictive trends
  └── AuditService        → AI compliance risk assessment
```

### 10.4 Prompt Management

Prompts are stored in `ai_prompts` table and managed via API:
- `GET /api/v1/ai/prompts` — List all prompts
- `POST /api/v1/ai/prompts` — Create/update prompt (upsert)
- Prompts support variable substitution: `{{INPUT}}`, `{{VERTICAL}}`, `{{TENANT_ID}}`, and arbitrary JSON context

**Current state**: 5 default prompts seeded in migration `1738479999998-AddSearchAndAiTables.ts` for entity analysis (immigration, grc, labour), document extraction, and form validation.

---

## 11. Technology Stack

| Layer | Technology | Version | Rationale |
|---|---|---|---|
| **Backend Framework** | NestJS | 11.x | Modular architecture, decorators, DI, guards/interceptors built-in |
| **Language** | TypeScript | 5.7 | Strict mode, decorators, type safety across modules |
| **Database** | PostgreSQL | 15 | RLS, JSONB, tsvector, pgvector — all needed features in one DB |
| **ORM** | TypeORM | 0.3.20 | Mature, NestJS-native, migration support |
| **Auth** | Passport.js | 0.7 | JWT, Local, SAML strategies; NestJS integration via @nestjs/passport |
| **Queue** | Bull/BullMQ | 4.x | Redis-backed, reliable, NestJS integration via @nestjs/bull |
| **Search** | Elasticsearch | 9.x | Full-text + faceting + suggestions; optional (PG full-text is fallback) |
| **Storage** | AWS S3 | SDK v2 | Universal object storage; S3-compatible alternatives work too |
| **AI Gateway** | OpenAI SDK + LangChain | 6.x / 1.x | Model-agnostic routing, embeddings, RAG |
| **Validation** | class-validator + Joi | 0.14 / 17.x | DTO validation (class-validator) + config validation (Joi) |
| **API Docs** | Swagger/OpenAPI | 11.x | Auto-generated from decorators at `/api` |
| **Frontend Framework** | Next.js | 15 (App Router) | RSC, streaming, server components, ISR |
| **Frontend UI** | shadcn/ui + Radix | Latest | Accessible, customizable, copy-paste components |
| **Frontend Styling** | Tailwind CSS | 4 | Utility-first, design tokens via CSS variables |
| **Frontend State** | Zustand + TanStack Query | 5 | Client state + server state separation |
| **Container** | Docker | Latest | Multi-stage builds, Alpine-based |
| **Orchestration** | Docker Compose → Kubernetes | — | Single-server today, multi-region tomorrow |
| **CI/CD** | GitHub Actions | — | Build, test, scan, deploy per environment |
| **Monitoring** | Prometheus + Grafana | Latest | Metrics, dashboards, alerting |
| **Security** | Helmet + rate-limit + Trivy | Latest | Headers, rate limiting, container scanning |

---

## Appendix A: Current vs. Target State Gap Analysis

| Component | Current State | Target State | Priority |
|---|---|---|---|
| 14 Core Modules | All 14 implemented as NestJS monolith | Extract into independent deployables | P2 |
| 4 Specialist Engines | Screening + DocIntel wired in `src/ai/engines/`; Radar + Vessel stubs | Full production engines for all 4 | P1 |
| JSON Config Packs | `packages/config-packs/au/immigration.json` + `ae/banking.json` on disk; auto-seeded at boot | Add KSA, UK, CA packs | P1 |
| God View (app.meru.com) | Built — `meru-dashboard` in `meru-core-fe` repo (Platform + Admin portals) | Production deploy; connect config-pack PR approvals | P1 |
| ImmiStack Frontend | Built in `meru-core-fe` (Next.js 15, 3 portals: admin/staff/client) | Production deploy; UAE launch | P1 |
| GovernanceX Frontend | Built in `meru-core-fe` (Next.js 15, 22 pages, i18n en/ar) | Production deploy; bank pilot | P2 |
| INT Adapters | AU HomeAffairs + UAE Central Bank active | IRCC, UKVI, Finacle, CBUAE additional endpoints | P2 |
| Multi-Region Deploy | Single AWS region | UAE, KSA, UK, AU regions with data residency | P3 |
| Monorepo Structure | Backend at `meru-core`; frontend at `meru-core-fe` (separate repo) | Full Turborepo monorepo | P2 |
| Testing | Minimal test coverage | Module-level unit tests, integration tests, E2E | P1 |

---

*This document is the definitive architecture reference for the Meru RegOS platform. All architectural decisions must be documented here and in the corresponding ADR under `docs/ADR/`.*

*Last updated: 2026-05-31 — Phases A/B/C complete: engines wired, INT adapters active (AU HomeAffairs + UAE Central Bank), config packs on disk, 3 frontend portals built in separate `meru-core-fe` repo.*
