# Meru RegOS — Database Schema Design

> **Version**: 1.1 | **Status**: Phase A/B/C implementation complete
> **Owner**: Meru Platform Team | **Last Updated**: 2026-05-31
>
> The definitive database design for the Meru Regulatory Operating System. Covers all 44 tables, relationships, indexes, RLS policies, JSONB schemas, partitioning, and migration strategy.
>
> See also: [ARCHITECTURE.md](./ARCHITECTURE.md) · [TRD.md](./TRD.md) · [DEVELOPMENT_STRATEGY.md](./DEVELOPMENT_STRATEGY.md)

---

## Table of Contents

1. [Entity-Relationship Overview](#1-entity-relationship-overview)
2. [Schema: Identity & Access Management (IAM)](#2-schema-identity--access-management-iam)
3. [Schema: Tenant Configuration (TCM)](#3-schema-tenant-configuration-tcm)
4. [Schema: Universal CRM](#4-schema-universal-crm)
5. [Schema: Document Management (DOC)](#5-schema-document-management-doc)
6. [Schema: Workflow Engine (WF)](#6-schema-workflow-engine-wf)
7. [Schema: Forms & Tasks (FORM / TASK)](#7-schema-forms--tasks-form--task)
8. [Schema: Communications & Notifications (COM)](#8-schema-communications--notifications-com)
9. [Schema: Billing & Payments (BILL)](#9-schema-billing--payments-bill)
10. [Schema: AI & Search (AI / SRCH)](#10-schema-ai--search-ai--srch)
11. [Schema: Audit & Analytics (AUD / BI)](#11-schema-audit--analytics-aud--bi)
12. [Schema: Integration Hub (INT)](#12-schema-integration-hub-int)
13. [RLS Policy Design](#13-rls-policy-design)
14. [Index Strategy](#14-index-strategy)
15. [Partitioning & Data Lifecycle](#15-partitioning--data-lifecycle)
16. [JSONB Schema Definitions](#16-jsonb-schema-definitions)
17. [Migration & Versioning Strategy](#17-migration--versioning-strategy)
18. [Connection & Pool Configuration](#18-connection--pool-configuration)
19. [Backup & Recovery](#19-backup--recovery)

---

## 1. Entity-Relationship Overview

### 1.1 Module-to-Table Map

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          MERU CORE DATABASE                              │
│                                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │   IAM    │  │   TCM    │  │   CRM    │  │   DOC    │  │    WF    │  │
│  │          │  │          │  │          │  │          │  │          │  │
│  │ tenants  │  │ tenant_  │  │ universal│  │ documents│  │ workflows│  │
│  │ users    │  │ settings │  │ _entities│  │ doc_     │  │ wf_      │  │
│  │ roles    │  │ feature_ │  │ entity_  │  │ versions │  │ states   │  │
│  │ sessions │  │ flags    │  │ relations│  │ doc_tags  │  │ wf_      │  │
│  │ api_keys │  │ config_  │  │ tags     │  │          │  │ instances│  │
│  │          │  │ packs    │  │ notes    │  │          │  │ wf_      │  │
│  │          │  │          │  │ tasks    │  │          │  │ history  │  │
│  │          │  │          │  │ cases    │  │          │  │ sla_rules│  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
│                                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │   FORM   │  │   COM    │  │   BILL   │  │  AI/SRCH │  │ AUD/BI   │  │
│  │          │  │          │  │          │  │          │  │          │  │
│  │ form_    │  │ communi_ │  │ billing_ │  │ ai_      │  │ audit_   │  │
│  │ schemas  │  │ cations  │  │ plans    │  │ requests │  │ logs     │  │
│  │ form_    │  │ message_ │  │ invoices │  │ ai_      │  │ analytics│  │
│  │ fields   │  │ templates│  │ payments │  │ responses│  │ _events  │  │
│  │ form_    │  │ notifi_  │  │ subscrip_│  │ search_  │  │ reports  │  │
│  │submissions│ │ cations  │  │ tions   │  │ indexes  │  │ dash_    │  │
│  │          │  │          │  │ usage_  │  │ embeddings│ │ boards  │  │
│  │          │  │          │  │ records │  │          │  │          │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
│                                                                          │
│  ┌──────────┐                                                           │
│  │   INT    │                                                           │
│  │          │                                                           │
│  │ integra_ │                                                           │
│  │ tion_    │                                                           │
│  │ adapters │                                                           │
│  │ api_     │                                                           │
│  │ call_logs│                                                           │
│  └──────────┘                                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Core Relationships (Simplified)

```
tenants ──1:N──▶ users
tenants ──1:N──▶ universal_entities
tenants ──1:N──▶ documents
tenants ──1:N──▶ workflows
tenants ──1:N──▶ cases
tenants ──1:N──▶ communications
tenants ──1:N──▶ invoices
tenants ──1:N──▶ audit_logs

users ──1:N──▶ cases (assigned_to)
users ──1:N──▶ tasks (assignee)
users ──1:N──▶ audit_logs (actor)

universal_entities ──1:N──▶ entity_relationships (source)
universal_entities ──1:N──▶ entity_relationships (target)
universal_entities ──1:N──▶ documents (linked_entity)
universal_entities ──1:N──▶ cases (primary_entity)

cases ──1:N──▶ tasks
cases ──1:N──▶ workflow_instances
cases ──1:N──▶ documents
cases ──1:N──▶ communications

workflows ──1:N──▶ workflow_states
workflow_states ──1:N──▶ workflow_transitions (from_state)
workflow_states ──1:N──▶ workflow_transitions (to_state)
workflows ──1:N──▶ workflow_instances

documents ──1:N──▶ document_versions

invoices ──1:N──▶ invoice_items
invoices ──1:N──▶ payments

ai_requests ──1:1──▶ ai_responses
```

### 1.3 Naming Conventions

| Convention | Example |
|---|---|
| Table names | `snake_case`, plural (`universal_entities`, `audit_logs`) |
| Primary keys | `id` (UUID v4) |
| Foreign keys | `{referenced_table_singular}_id` (`tenant_id`, `assigned_user_id`) |
| Timestamps | `created_at`, `updated_at`, `deleted_at` (soft delete) |
| JSONB columns | Descriptive noun (`settings`, `context`, `attributes`, `metadata`) |
| Enum columns | `{purpose}_type` or `status` (`entity_type`, `case_status`) |
| Indexes | Auto-generated by TypeORM, manual for JSONB/GIN |
| Junction tables | `{table1}_{table2}` (`entity_relationships`, `document_tags`) |

---

## 2. Schema: Identity & Access Management (IAM)

### 2.1 tenants

The central multi-tenancy table. Every row is an isolated tenant (firm, bank, organization).

```sql
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            VARCHAR(100) NOT NULL UNIQUE,        -- subdomain identifier
    name            VARCHAR(255) NOT NULL,               -- display name
    vertical        VARCHAR(50) NOT NULL,                -- immigration, grc, labour, fintech, legal, health, tax, education
    status          VARCHAR(20) NOT NULL DEFAULT 'trial', -- trial, active, suspended, deleted
    plan            VARCHAR(30) NOT NULL DEFAULT 'free',  -- free, starter, professional, enterprise
    settings        JSONB NOT NULL DEFAULT '{}',          -- branding, limits, features (see JSONB schema §16.1)
    sso_config      JSONB NOT NULL DEFAULT '{}',          -- SAML/OIDC configuration (see JSONB schema §16.2)
    metadata        JSONB NOT NULL DEFAULT '{}',          -- extensible metadata
    trial_ends_at           TIMESTAMP WITH TIME ZONE,
    subscription_renews_at  TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMP WITH TIME ZONE              -- soft delete
);

CREATE INDEX idx_tenants_slug ON tenants (slug);
CREATE INDEX idx_tenants_status ON tenants (status);
CREATE INDEX idx_tenants_vertical ON tenants (vertical);
CREATE INDEX idx_tenants_plan ON tenants (plan);
```

**RLS**: `tenants` is the **root isolation table**. God-mode (`app.meru.com`) bypasses RLS. No other tenant may read this table except their own row.

### 2.2 users

```sql
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    email           VARCHAR(255) NOT NULL,
    password_hash   VARCHAR(255),                        -- NULL for SSO-only users
    first_name      VARCHAR(100),
    last_name       VARCHAR(100),
    phone           VARCHAR(30),
    avatar_url      VARCHAR(500),
    provider        VARCHAR(20) NOT NULL DEFAULT 'local', -- local, saml, oidc, google
    provider_id     VARCHAR(255),                        -- external provider user ID
    roles           TEXT[] NOT NULL DEFAULT '{}',         -- array of role codes
    attributes      JSONB NOT NULL DEFAULT '{}',          -- extensible user attributes
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    mfa_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    mfa_secret      VARCHAR(255),
    last_login_at   TIMESTAMP WITH TIME ZONE,
    last_login_ip   VARCHAR(45),
    password_changed_at TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMP WITH TIME ZONE,

    UNIQUE (tenant_id, email)
);

CREATE INDEX idx_users_tenant ON users (tenant_id);
CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_provider ON users (tenant_id, provider);
CREATE INDEX idx_users_roles ON users USING GIN (roles);
```

**RLS**: Users can only see users within their own tenant. Platform admins can see all tenants' users.

### 2.3 roles

```sql
CREATE TABLE roles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    name            VARCHAR(100) NOT NULL,
    code            VARCHAR(50) NOT NULL,                -- machine-readable (firm_admin, agent, client)
    description     TEXT,
    permissions     TEXT[] NOT NULL DEFAULT '{}',         -- array of permission codes
    is_system       BOOLEAN NOT NULL DEFAULT FALSE,      -- system roles cannot be deleted
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, code)
);

CREATE INDEX idx_roles_tenant ON roles (tenant_id);
CREATE INDEX idx_roles_permissions ON roles USING GIN (permissions);
```

### 2.4 sessions

```sql
CREATE TABLE sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    token_hash      VARCHAR(255) NOT NULL UNIQUE,         -- SHA-256 of JWT
    refresh_hash    VARCHAR(255),                         -- SHA-256 of refresh token
    ip_address      VARCHAR(45),
    user_agent      TEXT,
    expires_at      TIMESTAMP WITH TIME ZONE NOT NULL,
    refreshed_at    TIMESTAMP WITH TIME ZONE,
    revoked_at      TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_tenant ON sessions (tenant_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_token ON sessions (token_hash);
```

### 2.5 api_keys

```sql
CREATE TABLE api_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    user_id         UUID REFERENCES users(id),           -- NULL for system-level keys
    name            VARCHAR(255) NOT NULL,
    key_hash        VARCHAR(255) NOT NULL UNIQUE,         -- SHA-256 of API key
    prefix          VARCHAR(8) NOT NULL,                  -- First 8 chars for display (mer_live_...)
    scopes          TEXT[] NOT NULL DEFAULT '{}',
    last_used_at    TIMESTAMP WITH TIME ZONE,
    expires_at      TIMESTAMP WITH TIME ZONE,
    revoked_at      TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_tenant ON api_keys (tenant_id);
CREATE INDEX idx_api_keys_hash ON api_keys (key_hash);
```

---

## 3. Schema: Tenant Configuration (TCM)

### 3.1 tenant_settings

Per-tenant configuration that controls behavior, branding, and limits.

```sql
CREATE TABLE tenant_settings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) UNIQUE,
    branding        JSONB NOT NULL DEFAULT '{}',          -- logo_url, colors, fonts (see JSONB schema §16.3)
    limits          JSONB NOT NULL DEFAULT '{}',          -- users_max, storage_gb, api_rate_limit
    features        JSONB NOT NULL DEFAULT '{}',          -- enabled_modules, ai_enabled, etc.
    compliance      JSONB NOT NULL DEFAULT '{}',          -- data_retention_days, audit_log_retention
    notifications   JSONB NOT NULL DEFAULT '{}',          -- email, sms, whatsapp preferences
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tenant_settings_tenant ON tenant_settings (tenant_id);
```

### 3.2 feature_flags

```sql
CREATE TABLE feature_flags (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    flag_key        VARCHAR(100) NOT NULL,
    enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    rollout_pct     INTEGER NOT NULL DEFAULT 100,         -- 0-100, for gradual rollout
    target_users    TEXT[],                               -- specific user IDs for beta features
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, flag_key)
);

CREATE INDEX idx_feature_flags_tenant ON feature_flags (tenant_id);
```

### 3.3 config_packs

Versioned JSON configuration packs for verticals and countries.

```sql
CREATE TABLE config_packs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pack_type       VARCHAR(20) NOT NULL,                 -- vertical, country
    code            VARCHAR(50) NOT NULL,                 -- immigration, uae, ksa, banking
    version         VARCHAR(20) NOT NULL,                 -- semver
    schema_version  VARCHAR(10) NOT NULL,                 -- JSON schema version this pack targets
    content         JSONB NOT NULL,                       -- the full pack JSON
    checksum        VARCHAR(64) NOT NULL,                 -- SHA-256 of content
    is_latest       BOOLEAN NOT NULL DEFAULT FALSE,
    published_by    UUID REFERENCES users(id),
    published_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    changelog       TEXT,

    UNIQUE (pack_type, code, version)
);

CREATE INDEX idx_config_packs_type_code ON config_packs (pack_type, code);
CREATE INDEX idx_config_packs_latest ON config_packs (pack_type, code) WHERE is_latest = TRUE;
```

### 3.4 tenant_config_pins

Which config pack version each tenant is pinned to.

```sql
CREATE TABLE tenant_config_pins (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    config_pack_id  UUID NOT NULL REFERENCES config_packs(id),
    pinned_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    pinned_by       UUID REFERENCES users(id),

    UNIQUE (tenant_id, config_pack_id)
);

CREATE INDEX idx_tenant_config_pins_tenant ON tenant_config_pins (tenant_id);
```

---

## 4. Schema: Universal CRM

### 4.1 universal_entities

The polymorphic entity table — every person, organization, asset, and case is stored here.

```sql
CREATE TABLE universal_entities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    entity_type     VARCHAR(30) NOT NULL,                -- person, organization, asset, case, application
    status          VARCHAR(30) NOT NULL DEFAULT 'active',
    -- Core identity fields
    first_name      VARCHAR(100),
    last_name       VARCHAR(100),
    full_legal_name VARCHAR(300),
    email           VARCHAR(255),
    phone_number    VARCHAR(30),
    alternate_phone VARCHAR(30),
    date_of_birth   DATE,
    nationality     VARCHAR(3),                          -- ISO 3166-1 alpha-3 country code
    -- Document identifiers
    passport_number     VARCHAR(50),
    passport_country    VARCHAR(3),
    passport_expiry     DATE,
    national_id         VARCHAR(50),
    tax_id              VARCHAR(50),
    -- Organization-specific
    registration_number VARCHAR(100),
    incorporation_date  DATE,
    -- Vertical-specific data (polymorphic)
    vertical_attributes JSONB NOT NULL DEFAULT '{}',     -- (see JSONB schema §16.4)
    -- Address
    address_line1   VARCHAR(255),
    address_line2   VARCHAR(255),
    city            VARCHAR(100),
    state_province  VARCHAR(100),
    postal_code     VARCHAR(30),
    country         VARCHAR(3),
    -- Metadata
    tags            TEXT[] DEFAULT '{}',
    metadata        JSONB NOT NULL DEFAULT '{}',
    -- Tracking
    created_by      UUID REFERENCES users(id),
    updated_by      UUID REFERENCES users(id),
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_ue_tenant ON universal_entities (tenant_id);
CREATE INDEX idx_ue_type ON universal_entities (tenant_id, entity_type);
CREATE INDEX idx_ue_status ON universal_entities (tenant_id, status);
CREATE INDEX idx_ue_email ON universal_entities (tenant_id, email) WHERE email IS NOT NULL;
CREATE INDEX idx_ue_name ON universal_entities (tenant_id, last_name, first_name);
CREATE INDEX idx_ue_nationality ON universal_entities (tenant_id, nationality);
CREATE INDEX idx_ue_passport ON universal_entities (tenant_id, passport_number) WHERE passport_number IS NOT NULL;
CREATE INDEX idx_ue_vertical_attrs ON universal_entities USING GIN (vertical_attributes jsonb_path_ops);
CREATE INDEX idx_ue_tags ON universal_entities USING GIN (tags);
CREATE INDEX idx_ue_created ON universal_entities (tenant_id, created_at DESC);
```

**RLS**: Scoped to `tenant_id`. Full CRUD isolation.

### 4.2 entity_relationships

Graph relationships between entities (e.g., "John is an employee of Acme Corp", "Case #123 involves Entity #456").

```sql
CREATE TABLE entity_relationships (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    source_entity_id UUID NOT NULL REFERENCES universal_entities(id) ON DELETE CASCADE,
    target_entity_id UUID NOT NULL REFERENCES universal_entities(id) ON DELETE CASCADE,
    relationship_type VARCHAR(50) NOT NULL,               -- employee_of, client_of, involves, subsidiary_of
    attributes      JSONB NOT NULL DEFAULT '{}',          -- e.g., { "job_title": "CEO", "ownership_pct": 51 }
    effective_from  DATE,
    effective_to    DATE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, source_entity_id, target_entity_id, relationship_type)
);

CREATE INDEX idx_er_tenant ON entity_relationships (tenant_id);
CREATE INDEX idx_er_source ON entity_relationships (source_entity_id);
CREATE INDEX idx_er_target ON entity_relationships (target_entity_id);
CREATE INDEX idx_er_type ON entity_relationships (tenant_id, relationship_type);
```

### 4.3 cases

Core case/work-item entity. Used by Immigration (visa applications), Banking (investigations), and all verticals.

```sql
CREATE TABLE cases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    case_number     VARCHAR(50) NOT NULL,                 -- human-readable, auto-generated
    case_type       VARCHAR(50) NOT NULL,                 -- visa_482, visa_186, sanctions_check, sar_filing
    title           VARCHAR(500) NOT NULL,
    description     TEXT,
    status          VARCHAR(30) NOT NULL DEFAULT 'open',
    priority        VARCHAR(10) NOT NULL DEFAULT 'medium', -- low, medium, high, urgent
    -- Relationships
    primary_entity_id UUID REFERENCES universal_entities(id),  -- the applicant/counterparty
    assigned_user_id UUID REFERENCES users(id),
    assigned_team_id UUID,                               -- future: team assignment
    parent_case_id  UUID REFERENCES cases(id),            -- for sub-cases
    -- Classification
    vertical        VARCHAR(50) NOT NULL,
    country         VARCHAR(3),
    -- Data
    case_data       JSONB NOT NULL DEFAULT '{}',          -- vertical-specific case fields (see JSONB schema §16.5)
    -- Dates
    due_date        TIMESTAMP WITH TIME ZONE,
    completed_at    TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMP WITH TIME ZONE
);

CREATE UNIQUE INDEX idx_cases_number ON cases (tenant_id, case_number);
CREATE INDEX idx_cases_tenant ON cases (tenant_id);
CREATE INDEX idx_cases_status ON cases (tenant_id, status);
CREATE INDEX idx_cases_type ON cases (tenant_id, case_type);
CREATE INDEX idx_cases_assigned ON cases (tenant_id, assigned_user_id);
CREATE INDEX idx_cases_entity ON cases (tenant_id, primary_entity_id);
CREATE INDEX idx_cases_priority ON cases (tenant_id, priority, due_date) WHERE status != 'closed';
CREATE INDEX idx_cases_due ON cases (tenant_id, due_date) WHERE status NOT IN ('closed', 'completed');
CREATE INDEX idx_cases_data ON cases USING GIN (case_data jsonb_path_ops);
```

### 4.4 notes

```sql
CREATE TABLE notes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    entity_id       UUID REFERENCES universal_entities(id),
    case_id         UUID REFERENCES cases(id),
    author_id       UUID NOT NULL REFERENCES users(id),
    content         TEXT NOT NULL,
    note_type       VARCHAR(30) NOT NULL DEFAULT 'general', -- general, file_note, compliance_note, system
    is_pinned       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notes_tenant ON notes (tenant_id);
CREATE INDEX idx_notes_entity ON notes (tenant_id, entity_id);
CREATE INDEX idx_notes_case ON notes (case_id);
CREATE INDEX idx_notes_author ON notes (author_id);
```

### 4.5 tags

```sql
CREATE TABLE tags (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    name            VARCHAR(100) NOT NULL,
    color           VARCHAR(7),                          -- hex color
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, name)
);

CREATE INDEX idx_tags_tenant ON tags (tenant_id);
```

### 4.6 entity_tags

```sql
CREATE TABLE entity_tags (
    entity_id       UUID NOT NULL REFERENCES universal_entities(id) ON DELETE CASCADE,
    tag_id          UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (entity_id, tag_id)
);
```

---

## 5. Schema: Document Management (DOC)

### 5.1 documents

```sql
CREATE TABLE documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    -- File info
    file_name       VARCHAR(500) NOT NULL,
    file_size       BIGINT NOT NULL,                     -- bytes
    mime_type       VARCHAR(100) NOT NULL,
    file_hash       VARCHAR(64) NOT NULL,                -- SHA-256 for deduplication
    -- Storage
    storage_provider VARCHAR(30) NOT NULL DEFAULT 's3',   -- s3, azure, gcs
    storage_bucket   VARCHAR(255) NOT NULL,               -- per-tenant bucket
    storage_key      VARCHAR(500) NOT NULL,               -- object key/path
    -- Relationships
    entity_id       UUID REFERENCES universal_entities(id),
    case_id         UUID REFERENCES cases(id),
    uploaded_by     UUID NOT NULL REFERENCES users(id),
    -- Classification
    doc_category    VARCHAR(50) NOT NULL,                 -- passport, payslip, bank_statement, contract, bill_of_lading
    doc_type        VARCHAR(50),                         -- more specific subtype
    tags            TEXT[] DEFAULT '{}',
    -- Processing
    ocr_status      VARCHAR(30) DEFAULT 'pending',       -- pending, processing, completed, failed
    ocr_text        TEXT,                                -- extracted OCR text
    ocr_confidence  DECIMAL(5,2),                        -- 0.00 - 100.00
    ai_analysis     JSONB,                               -- extracted structured data (see JSONB schema §16.6)
    -- Lifecycle
    status          VARCHAR(30) NOT NULL DEFAULT 'pending_review', -- pending_review, approved, rejected, expired
    expiry_date     DATE,
    version_count   INTEGER NOT NULL DEFAULT 1,
    is_current_version BOOLEAN NOT NULL DEFAULT TRUE,
    is_encrypted    BOOLEAN NOT NULL DEFAULT FALSE,
    kms_key_id      VARCHAR(255),                        -- per-tenant KMS key for encryption
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_docs_tenant ON documents (tenant_id);
CREATE INDEX idx_docs_entity ON documents (tenant_id, entity_id);
CREATE INDEX idx_docs_case ON documents (case_id);
CREATE INDEX idx_docs_status ON documents (tenant_id, status);
CREATE INDEX idx_docs_category ON documents (tenant_id, doc_category);
CREATE INDEX idx_docs_expiry ON documents (tenant_id, expiry_date) WHERE expiry_date IS NOT NULL AND status = 'approved';
CREATE INDEX idx_docs_hash ON documents (file_hash);       -- deduplication check
CREATE INDEX idx_docs_ocr ON documents (tenant_id, ocr_status) WHERE ocr_status IN ('pending', 'processing');
```

### 5.2 document_versions

```sql
CREATE TABLE document_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number  INTEGER NOT NULL,
    file_size       BIGINT NOT NULL,
    file_hash       VARCHAR(64) NOT NULL,
    storage_key     VARCHAR(500) NOT NULL,
    uploaded_by     UUID NOT NULL REFERENCES users(id),
    change_reason   TEXT,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (document_id, version_number)
);

CREATE INDEX idx_doc_versions_doc ON document_versions (document_id);
```

---

## 6. Schema: Workflow Engine (WF)

### 6.1 workflows

```sql
CREATE TABLE workflows (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    name            VARCHAR(255) NOT NULL,
    code            VARCHAR(100) NOT NULL,                -- machine-readable identifier
    description     TEXT,
    vertical        VARCHAR(50) NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sla_config      JSONB NOT NULL DEFAULT '{}',          -- default SLA rules (see JSONB schema §16.7)
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, code, version)
);

CREATE INDEX idx_workflows_tenant ON workflows (tenant_id);
CREATE INDEX idx_workflows_code ON workflows (tenant_id, code, version);
```

### 6.2 workflow_states

```sql
CREATE TABLE workflow_states (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    code            VARCHAR(50) NOT NULL,                 -- machine-readable
    state_type      VARCHAR(30) NOT NULL DEFAULT 'intermediate', -- start, intermediate, end, cancelled
    display_order   INTEGER NOT NULL DEFAULT 0,
    color           VARCHAR(7),                           -- hex color for UI
    sla_duration_hours INTEGER,                          -- max time in this state
    is_required     BOOLEAN NOT NULL DEFAULT TRUE,
    metadata        JSONB NOT NULL DEFAULT '{}',

    UNIQUE (workflow_id, code)
);

CREATE INDEX idx_wf_states_workflow ON workflow_states (workflow_id);
```

### 6.3 workflow_transitions

```sql
CREATE TABLE workflow_transitions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    from_state_id   UUID NOT NULL REFERENCES workflow_states(id) ON DELETE CASCADE,
    to_state_id     UUID NOT NULL REFERENCES workflow_states(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    code            VARCHAR(50) NOT NULL,
    conditions      JSONB NOT NULL DEFAULT '{}',          -- gate conditions (see JSONB schema §16.8)
    actions         JSONB NOT NULL DEFAULT '[]',          -- side effects on transition
    required_roles  TEXT[] DEFAULT '{}',                  -- who can trigger this transition

    UNIQUE (workflow_id, from_state_id, to_state_id, code)
);

CREATE INDEX idx_wf_transitions_workflow ON workflow_transitions (workflow_id);
CREATE INDEX idx_wf_transitions_from ON workflow_transitions (from_state_id);
```

### 6.4 workflow_instances

```sql
CREATE TABLE workflow_instances (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    workflow_id     UUID NOT NULL REFERENCES workflows(id),
    case_id         UUID REFERENCES cases(id),
    entity_id       UUID REFERENCES universal_entities(id),
    current_state_id UUID NOT NULL REFERENCES workflow_states(id),
    status          VARCHAR(30) NOT NULL DEFAULT 'active', -- active, completed, cancelled, suspended
    context         JSONB NOT NULL DEFAULT '{}',          -- runtime data (see JSONB schema §16.9)
    sla_deadline    TIMESTAMP WITH TIME ZONE,
    started_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wf_inst_tenant ON workflow_instances (tenant_id);
CREATE INDEX idx_wf_inst_workflow ON workflow_instances (tenant_id, workflow_id);
CREATE INDEX idx_wf_inst_case ON workflow_instances (case_id);
CREATE INDEX idx_wf_inst_status ON workflow_instances (tenant_id, status);
CREATE INDEX idx_wf_inst_sla ON workflow_instances (tenant_id, sla_deadline) WHERE status = 'active';
CREATE INDEX idx_wf_inst_context ON workflow_instances USING GIN (context jsonb_path_ops);
```

### 6.5 workflow_history

```sql
CREATE TABLE workflow_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id     UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    transition_id   UUID REFERENCES workflow_transitions(id),
    from_state_id   UUID REFERENCES workflow_states(id),
    to_state_id     UUID NOT NULL REFERENCES workflow_states(id),
    triggered_by    UUID NOT NULL REFERENCES users(id),
    trigger_type    VARCHAR(30) NOT NULL DEFAULT 'manual', -- manual, automatic, scheduled
    comments        TEXT,
    duration_ms     INTEGER,                             -- time spent in from_state
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wf_history_instance ON workflow_history (instance_id);
CREATE INDEX idx_wf_history_tenant ON workflow_history (tenant_id, created_at DESC);
```

### 6.6 sla_rules

```sql
CREATE TABLE sla_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    workflow_id     UUID REFERENCES workflows(id),
    state_id        UUID REFERENCES workflow_states(id),
    name            VARCHAR(255) NOT NULL,
    duration_hours  INTEGER NOT NULL,                    -- max allowed hours
    business_hours_only BOOLEAN NOT NULL DEFAULT FALSE,
    escalation_steps JSONB NOT NULL DEFAULT '[]',         -- ordered escalation actions (see JSONB schema §16.10)
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sla_rules_tenant ON sla_rules (tenant_id);
CREATE INDEX idx_sla_rules_workflow ON sla_rules (workflow_id);
```

---

## 7. Schema: Forms & Tasks (FORM / TASK)

### 7.1 form_schemas

```sql
CREATE TABLE form_schemas (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    name            VARCHAR(255) NOT NULL,
    code            VARCHAR(100) NOT NULL,
    description     TEXT,
    version         INTEGER NOT NULL DEFAULT 1,
    schema_definition JSONB NOT NULL,                     -- JSON Schema v7 form definition
    ui_layout       JSONB NOT NULL DEFAULT '{}',          -- UI hints (grid, sections, conditional visibility)
    validation_rules JSONB NOT NULL DEFAULT '{}',          -- custom validation
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, code, version)
);

CREATE INDEX idx_form_schemas_tenant ON form_schemas (tenant_id);
```

### 7.2 form_fields

```sql
CREATE TABLE form_fields (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    form_schema_id  UUID NOT NULL REFERENCES form_schemas(id) ON DELETE CASCADE,
    field_key       VARCHAR(100) NOT NULL,
    field_type      VARCHAR(50) NOT NULL,                 -- text, number, date, select, file, rich_text, repeating_group
    label           VARCHAR(255) NOT NULL,
    placeholder     VARCHAR(500),
    help_text       TEXT,
    is_required     BOOLEAN NOT NULL DEFAULT FALSE,
    default_value   JSONB,
    options         JSONB,                                -- for select/multi-select fields
    validation      JSONB,                                -- field-level validation rules
    display_order   INTEGER NOT NULL DEFAULT 0,
    visibility_condition JSONB,                           -- { "field": "visa_type", "operator": "equals", "value": "482" }

    UNIQUE (form_schema_id, field_key)
);

CREATE INDEX idx_form_fields_schema ON form_fields (form_schema_id);
```

### 7.3 form_submissions

```sql
CREATE TABLE form_submissions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    form_schema_id  UUID NOT NULL REFERENCES form_schemas(id),
    case_id         UUID REFERENCES cases(id),
    entity_id       UUID REFERENCES universal_entities(id),
    submitted_by    UUID REFERENCES users(id),
    data            JSONB NOT NULL,                       -- submitted field values
    status          VARCHAR(30) NOT NULL DEFAULT 'draft',  -- draft, submitted, under_review, approved, rejected
    submitted_at    TIMESTAMP WITH TIME ZONE,
    reviewed_by     UUID REFERENCES users(id),
    reviewed_at     TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_form_submissions_tenant ON form_submissions (tenant_id);
CREATE INDEX idx_form_submissions_case ON form_submissions (case_id);
CREATE INDEX idx_form_submissions_status ON form_submissions (tenant_id, status);
```

### 7.4 tasks

```sql
CREATE TABLE tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    title           VARCHAR(500) NOT NULL,
    description     TEXT,
    status          VARCHAR(30) NOT NULL DEFAULT 'todo',   -- todo, in_progress, blocked, done, cancelled
    priority        VARCHAR(10) NOT NULL DEFAULT 'medium',  -- low, medium, high, urgent
    -- Relationships
    case_id         UUID REFERENCES cases(id),
    entity_id       UUID REFERENCES universal_entities(id),
    assigned_to     UUID REFERENCES users(id),
    assigned_by     UUID REFERENCES users(id),
    parent_task_id  UUID REFERENCES tasks(id),
    -- Scheduling
    due_date        TIMESTAMP WITH TIME ZONE,
    started_at      TIMESTAMP WITH TIME ZONE,
    completed_at    TIMESTAMP WITH TIME ZONE,
    estimated_hours DECIMAL(6,2),
    actual_hours    DECIMAL(6,2),
    -- Metadata
    tags            TEXT[] DEFAULT '{}',
    task_data       JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_tasks_tenant ON tasks (tenant_id);
CREATE INDEX idx_tasks_assigned ON tasks (tenant_id, assigned_to);
CREATE INDEX idx_tasks_status ON tasks (tenant_id, status);
CREATE INDEX idx_tasks_case ON tasks (case_id);
CREATE INDEX idx_tasks_due ON tasks (tenant_id, due_date) WHERE status NOT IN ('done', 'cancelled');
CREATE INDEX idx_tasks_priority ON tasks (tenant_id, priority, due_date);
```

### 7.5 task_dependencies

```sql
CREATE TABLE task_dependencies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_id   UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    dependency_type VARCHAR(30) NOT NULL DEFAULT 'blocks', -- blocks, requires_review

    UNIQUE (task_id, depends_on_id)
);

CREATE INDEX idx_task_deps_task ON task_dependencies (task_id);
CREATE INDEX idx_task_deps_depends ON task_dependencies (depends_on_id);
```

---

## 8. Schema: Communications & Notifications (COM)

### 8.1 communications

```sql
CREATE TABLE communications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    -- Content
    channel         VARCHAR(20) NOT NULL,                 -- email, sms, whatsapp, internal_note, system
    direction       VARCHAR(10) NOT NULL DEFAULT 'outbound', -- inbound, outbound
    subject         VARCHAR(500),
    body            TEXT,
    body_html       TEXT,
    -- Participants
    sender_id       UUID REFERENCES users(id),
    sender_address  VARCHAR(255),
    recipient_id    UUID REFERENCES users(id),
    recipient_address VARCHAR(255),
    recipient_name  VARCHAR(255),
    -- Relationships
    case_id         UUID REFERENCES cases(id),
    entity_id       UUID REFERENCES universal_entities(id),
    task_id         UUID REFERENCES tasks(id),
    -- Tracking
    status          VARCHAR(30) NOT NULL DEFAULT 'pending', -- pending, sent, delivered, read, failed, bounced
    external_id     VARCHAR(255),                        -- provider message ID (Twilio, SendGrid, etc.)
    error_message   TEXT,
    sent_at         TIMESTAMP WITH TIME ZONE,
    delivered_at    TIMESTAMP WITH TIME ZONE,
    read_at         TIMESTAMP WITH TIME ZONE,
    -- Metadata
    metadata        JSONB NOT NULL DEFAULT '{}',          -- provider-specific metadata
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_comms_tenant ON communications (tenant_id);
CREATE INDEX idx_comms_case ON communications (case_id);
CREATE INDEX idx_comms_entity ON communications (tenant_id, entity_id);
CREATE INDEX idx_comms_channel_status ON communications (tenant_id, channel, status);
CREATE INDEX idx_comms_created ON communications (tenant_id, created_at DESC);
```

### 8.2 message_templates

```sql
CREATE TABLE message_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    name            VARCHAR(255) NOT NULL,
    code            VARCHAR(100) NOT NULL,
    channel         VARCHAR(20) NOT NULL,                 -- email, sms, whatsapp
    language        VARCHAR(5) NOT NULL DEFAULT 'en',     -- ISO 639-1
    subject         VARCHAR(500),                         -- email subject (null for SMS/WhatsApp)
    body_template   TEXT NOT NULL,                        -- Handlebars/Mustache template
    body_html       TEXT,                                 -- HTML version (email)
    variables       JSONB NOT NULL DEFAULT '{}',          -- expected template variables with types
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, code, language, channel)
);

CREATE INDEX idx_msg_templates_tenant ON message_templates (tenant_id);
```

### 8.3 notifications

```sql
CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    type            VARCHAR(50) NOT NULL,                 -- task_assigned, case_updated, doc_approved, sla_warning, mention
    title           VARCHAR(255) NOT NULL,
    body            TEXT,
    action_url      VARCHAR(500),                         -- deep link to relevant page
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    is_actioned     BOOLEAN NOT NULL DEFAULT FALSE,       -- user clicked/responded
    source_type     VARCHAR(50),                          -- case, task, document, communication
    source_id       UUID,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications (tenant_id, user_id, is_read, created_at DESC);
CREATE INDEX idx_notifications_source ON notifications (source_type, source_id);
```

---

## 9. Schema: Billing & Payments (BILL)

### 9.1 billing_plans

```sql
CREATE TABLE billing_plans (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(50) NOT NULL UNIQUE,           -- free, starter, professional, enterprise
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    price_per_seat_monthly  DECIMAL(10,2),
    price_per_seat_yearly   DECIMAL(10,2),
    included_storage_gb     INTEGER NOT NULL DEFAULT 5,
    included_api_calls      INTEGER,                      -- NULL = unlimited
    features        JSONB NOT NULL DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
```

**RLS**: `billing_plans` is a **shared table** — all tenants can read it. Only platform admins can write.

### 9.2 subscriptions

```sql
CREATE TABLE subscriptions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) UNIQUE,
    plan_id         UUID NOT NULL REFERENCES billing_plans(id),
    status          VARCHAR(30) NOT NULL DEFAULT 'active', -- active, past_due, cancelled, trialing
    billing_cycle   VARCHAR(10) NOT NULL DEFAULT 'monthly', -- monthly, yearly
    seats           INTEGER NOT NULL DEFAULT 5,
    current_period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    current_period_end   TIMESTAMP WITH TIME ZONE NOT NULL,
    stripe_subscription_id VARCHAR(255),
    stripe_customer_id     VARCHAR(255),
    cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
    trial_end_at    TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_subscriptions_tenant ON subscriptions (tenant_id);
CREATE INDEX idx_subscriptions_stripe ON subscriptions (stripe_subscription_id);
```

### 9.3 invoices

```sql
CREATE TABLE invoices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    subscription_id UUID REFERENCES subscriptions(id),
    invoice_number  VARCHAR(50) NOT NULL,
    status          VARCHAR(30) NOT NULL DEFAULT 'draft', -- draft, open, paid, void, uncollectible
    currency        VARCHAR(3) NOT NULL DEFAULT 'AED',
    subtotal        DECIMAL(12,2) NOT NULL,
    tax_amount      DECIMAL(12,2) NOT NULL DEFAULT 0,
    total           DECIMAL(12,2) NOT NULL,
    stripe_invoice_id VARCHAR(255),
    stripe_invoice_url TEXT,
    due_date        DATE NOT NULL,
    paid_at         TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_invoices_number ON invoices (tenant_id, invoice_number);
CREATE INDEX idx_invoices_tenant ON invoices (tenant_id);
CREATE INDEX idx_invoices_status ON invoices (tenant_id, status);
```

### 9.4 invoice_items

```sql
CREATE TABLE invoice_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    description     VARCHAR(500) NOT NULL,
    quantity        INTEGER NOT NULL DEFAULT 1,
    unit_price      DECIMAL(10,2) NOT NULL,
    amount          DECIMAL(12,2) NOT NULL,
    item_type       VARCHAR(50) NOT NULL DEFAULT 'subscription', -- subscription, usage, credit, tax
    metadata        JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_invoice_items_invoice ON invoice_items (invoice_id);
```

### 9.5 payments

```sql
CREATE TABLE payments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    invoice_id      UUID REFERENCES invoices(id),
    amount          DECIMAL(12,2) NOT NULL,
    currency        VARCHAR(3) NOT NULL DEFAULT 'AED',
    status          VARCHAR(30) NOT NULL DEFAULT 'pending', -- pending, succeeded, failed, refunded
    payment_method  VARCHAR(50),                            -- card, bank_transfer, wallet
    stripe_payment_intent_id VARCHAR(255),
    error_message   TEXT,
    refunded_amount DECIMAL(12,2),
    refunded_at     TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_tenant ON payments (tenant_id);
CREATE INDEX idx_payments_invoice ON payments (invoice_id);
CREATE INDEX idx_payments_status ON payments (tenant_id, status);
```

### 9.6 usage_records

```sql
CREATE TABLE usage_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    metric          VARCHAR(50) NOT NULL,                 -- api_calls, ai_tokens, ocr_pages, screening_checks, storage_gb
    quantity        DECIMAL(12,4) NOT NULL,
    unit            VARCHAR(20) NOT NULL,                  -- call, token, page, check, gb
    recorded_at     TIMESTAMP WITH TIME ZONE NOT NULL,     -- when usage occurred (bucket)
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_usage_tenant_metric ON usage_records (tenant_id, metric, recorded_at);
```

**Partitioning**: `usage_records` is partitioned by month on `recorded_at` (see §15).

---

## 10. Schema: AI & Search (AI / SRCH)

### 10.1 ai_requests

```sql
CREATE TABLE ai_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    model           VARCHAR(100) NOT NULL,                -- gpt-4o, claude-opus-4, etc.
    provider        VARCHAR(50) NOT NULL,                 -- openai, anthropic, azure, local
    messages        JSONB NOT NULL,                       -- chat message array
    parameters      JSONB NOT NULL DEFAULT '{}',          -- temperature, max_tokens, top_p
    citations       JSONB,                                -- extracted citations with source URLs
    token_count_input  INTEGER,
    token_count_output INTEGER,
    cost            DECIMAL(12,6),
    latency_ms      INTEGER,
    status          VARCHAR(30) NOT NULL DEFAULT 'pending', -- pending, streaming, completed, failed, moderated
    error_message   TEXT,
    case_id         UUID REFERENCES cases(id),
    entity_id       UUID REFERENCES universal_entities(id),
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_requests_tenant ON ai_requests (tenant_id, created_at DESC);
CREATE INDEX idx_ai_requests_user ON ai_requests (tenant_id, user_id);
CREATE INDEX idx_ai_requests_model ON ai_requests (tenant_id, model, created_at DESC);
```

**Partitioning**: `ai_requests` is partitioned by month on `created_at` (see §15).

### 10.2 ai_responses

```sql
CREATE TABLE ai_responses (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      UUID NOT NULL REFERENCES ai_requests(id) ON DELETE CASCADE UNIQUE,
    content         TEXT NOT NULL,
    citations       JSONB,                                -- parsed citation objects with source, text, confidence
    finish_reason   VARCHAR(30),                          -- stop, length, content_filter, tool_calls
    tool_calls      JSONB,                                -- function calling results
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_responses_request ON ai_responses (request_id);
```

### 10.3 embeddings

```sql
CREATE TABLE embeddings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    source_type     VARCHAR(50) NOT NULL,                 -- document, case, entity, regulation, message
    source_id       UUID NOT NULL,
    model           VARCHAR(100) NOT NULL,                -- text-embedding-3-small, voyage-3, etc.
    embedding       VECTOR(1536),                          -- pgvector (dimensions vary by model)
    chunk_index     INTEGER NOT NULL DEFAULT 0,            -- for chunked documents
    chunk_text      TEXT,                                  -- the source text that was embedded
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_embeddings_source ON embeddings (source_type, source_id);
CREATE INDEX idx_embeddings_tenant ON embeddings (tenant_id);
-- IVF index for vector similarity search
CREATE INDEX idx_embeddings_vector ON embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### 10.4 search_indexes

```sql
CREATE TABLE search_indexes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    source_type     VARCHAR(50) NOT NULL,
    source_id       UUID NOT NULL,
    title           VARCHAR(500),
    content_text    TEXT,                                  -- compiled text for full-text search
    tsv             TSVECTOR,                              -- PostgreSQL full-text search vector
    indexed_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, source_type, source_id)
);

CREATE INDEX idx_search_tenant ON search_indexes (tenant_id);
CREATE INDEX idx_search_tsv ON search_indexes USING GIN (tsv);
CREATE INDEX idx_search_source ON search_indexes (source_type, source_id);
```

---

## 11. Schema: Audit & Analytics (AUD / BI)

### 11.1 audit_logs

The tamper-evident audit trail. Every state-changing operation writes here.

```sql
CREATE TABLE audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    -- Event
    event_type      VARCHAR(50) NOT NULL,                 -- created, updated, deleted, viewed, exported, login, logout
    entity_type     VARCHAR(50) NOT NULL,                 -- case, document, user, payment, task
    entity_id       UUID,
    -- Actor
    actor_id        UUID REFERENCES users(id),
    actor_ip        VARCHAR(45),
    actor_user_agent TEXT,
    -- Changes
    action          VARCHAR(255) NOT NULL,                 -- human-readable description
    changes         JSONB,                                -- diff of changed fields (see JSONB schema §16.11)
    -- Integrity
    previous_hash   VARCHAR(64),                          -- hash of previous log entry (chain)
    current_hash    VARCHAR(64) NOT NULL,                  -- SHA-256 of this entry
    -- Metadata
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_tenant ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX idx_audit_actor ON audit_logs (actor_id);
CREATE INDEX idx_audit_event ON audit_logs (tenant_id, event_type, created_at DESC);
CREATE INDEX idx_audit_hash ON audit_logs (current_hash);
```

**Partitioning**: `audit_logs` is partitioned by month on `created_at` (see §15).
**RLS**: Audit logs are read-only per tenant. No tenant can modify audit_logs. God mode can read across tenants.

### 11.2 analytics_events

Raw analytics events for aggregation and BI.

```sql
CREATE TABLE analytics_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    event_name      VARCHAR(100) NOT NULL,                -- case_created, document_uploaded, payment_received, login
    event_category  VARCHAR(50),                           -- case, document, payment, user, workflow
    user_id         UUID REFERENCES users(id),
    entity_type     VARCHAR(50),
    entity_id       UUID,
    properties      JSONB NOT NULL DEFAULT '{}',           -- arbitrary event properties
    recorded_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_analytics_tenant ON analytics_events (tenant_id, recorded_at DESC);
CREATE INDEX idx_analytics_event ON analytics_events (tenant_id, event_name, recorded_at DESC);
CREATE INDEX idx_analytics_category ON analytics_events (tenant_id, event_category, recorded_at DESC);
```

**Partitioning**: `analytics_events` is partitioned by month on `recorded_at` (see §15).

### 11.3 reports

```sql
CREATE TABLE reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    report_type     VARCHAR(50) NOT NULL,                 -- dashboard, scheduled, ad_hoc, regulatory
    query_definition JSONB NOT NULL,                      -- stored query parameters
    output_format   VARCHAR(20) NOT NULL DEFAULT 'json',  -- json, csv, pdf, xlsx
    schedule        VARCHAR(50),                           -- cron expression for scheduled reports
    recipients      TEXT[],                               -- email addresses for scheduled delivery
    created_by      UUID NOT NULL REFERENCES users(id),
    last_run_at     TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reports_tenant ON reports (tenant_id);
```

### 11.4 dashboards

```sql
CREATE TABLE dashboards (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    user_id         UUID REFERENCES users(id),           -- NULL = shared dashboard
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    layout          JSONB NOT NULL DEFAULT '[]',           -- array of widget positions
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    is_shared       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, user_id, name)
);

CREATE INDEX idx_dashboards_tenant ON dashboards (tenant_id);
```

---

## 12. Schema: Integration Hub (INT)

### 12.1 integration_adapters

```sql
CREATE TABLE integration_adapters (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(100) NOT NULL UNIQUE,          -- uae_mohre, ksa_qiwa, au_homeaffairs, uk_fca
    name            VARCHAR(255) NOT NULL,
    country         VARCHAR(3) NOT NULL,
    regulator       VARCHAR(255) NOT NULL,
    base_url        VARCHAR(500) NOT NULL,
    auth_type       VARCHAR(30) NOT NULL DEFAULT 'api_key', -- api_key, oauth2, mutual_tls
    auth_config     JSONB NOT NULL DEFAULT '{}',            -- encrypted credentials reference
    rate_limit_rpm  INTEGER NOT NULL DEFAULT 60,            -- requests per minute
    timeout_ms      INTEGER NOT NULL DEFAULT 30000,
    retry_config    JSONB NOT NULL DEFAULT '{}',             -- max_retries, backoff_multiplier
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    health_status   VARCHAR(30) DEFAULT 'unknown',          -- unknown, healthy, degraded, down
    last_health_check TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
```

**RLS**: Readable by all tenants. Writable only by platform admins.

### 12.2 api_call_logs

```sql
CREATE TABLE api_call_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    adapter_id      UUID NOT NULL REFERENCES integration_adapters(id),
    endpoint        VARCHAR(500) NOT NULL,
    method          VARCHAR(10) NOT NULL,
    request_headers JSONB,
    request_body    JSONB,
    response_status INTEGER,
    response_body   JSONB,
    latency_ms      INTEGER,
    error_message   TEXT,
    idempotency_key VARCHAR(255),
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_logs_tenant ON api_call_logs (tenant_id, created_at DESC);
CREATE INDEX idx_api_logs_adapter ON api_call_logs (adapter_id, created_at DESC);
CREATE INDEX idx_api_logs_status ON api_call_logs (adapter_id, response_status, created_at DESC);
```

**Partitioning**: `api_call_logs` is partitioned by month on `created_at` (see §15).

---

## 13. RLS Policy Design

### 13.1 PostgreSQL RLS Function

The `app.set_context()` function (called by `TenantContextMiddleware`) sets session-level variables:

```sql
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.set_context(
    p_vertical VARCHAR(50),
    p_environment VARCHAR(50)
) RETURNS VOID AS $$
BEGIN
    PERFORM set_config('app.vertical', p_vertical, FALSE);
    PERFORM set_config('app.environment', p_environment, FALSE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 13.2 Standard Tenant Isolation Policy

Applied to every table with a `tenant_id` column:

```sql
-- Enable RLS on the table
ALTER TABLE universal_entities ENABLE ROW LEVEL SECURITY;

-- Policy: tenant can only see its own rows
CREATE POLICY tenant_isolation ON universal_entities
    FOR ALL
    TO authenticated
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- Policy: god mode can see everything
CREATE POLICY god_mode_read ON universal_entities
    FOR SELECT
    TO authenticated
    USING (current_setting('app.is_god_mode', TRUE)::BOOLEAN = TRUE);
```

### 13.3 Shared Table Policies

Tables like `billing_plans`, `integration_adapters`, and `config_packs` are shared across tenants:

```sql
-- All tenants can read, only platform can write
ALTER TABLE billing_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY shared_read ON billing_plans
    FOR SELECT
    TO authenticated
    USING (TRUE);

CREATE POLICY platform_write ON billing_plans
    FOR INSERT, UPDATE, DELETE
    TO authenticated
    USING (current_setting('app.is_god_mode', TRUE)::BOOLEAN = TRUE);
```

### 13.4 RLS Policy Checklist Per Table

| Table | Read | Insert | Update | Delete | Notes |
|---|---|---|---|---|---|
| tenants | Own row | God only | Own settings | God only | Status field restricted |
| users | Tenant-scoped | Tenant-scoped | Tenant-scoped | Soft-delete | Cannot change tenant_id |
| roles | Tenant-scoped | Tenant-scoped | Tenant-scoped | Tenant-scoped | System roles protected |
| sessions | Own sessions | Own sessions | — | Own sessions | |
| api_keys | Tenant-scoped | Tenant-scoped | Tenant-scoped | Tenant-scoped | |
| tenant_settings | Tenant-scoped | Tenant-scoped | Tenant-scoped | God only | |
| feature_flags | Tenant-scoped | Tenant-scoped | Tenant-scoped | God only | |
| config_packs | All tenants (read) | God only | God only | God only | Versioned, immutable |
| universal_entities | Tenant-scoped | Tenant-scoped | Tenant-scoped | Soft-delete | |
| entity_relationships | Tenant-scoped | Tenant-scoped | Tenant-scoped | Tenant-scoped | |
| cases | Tenant-scoped | Tenant-scoped | Tenant-scoped | Soft-delete | |
| notes | Tenant-scoped | Tenant-scoped | Own notes | Own notes | |
| documents | Tenant-scoped | Tenant-scoped | Tenant-scoped | Tenant-scoped | |
| workflows | Tenant-scoped | Tenant-scoped | Tenant-scoped | Tenant-scoped | |
| workflow_instances | Tenant-scoped | Tenant-scoped | Tenant-scoped | Tenant-scoped | |
| workflow_history | Tenant-scoped (read) | System only | — | — | Append-only |
| sla_rules | Tenant-scoped | Tenant-scoped | Tenant-scoped | Tenant-scoped | |
| form_schemas | Tenant-scoped | Tenant-scoped | Tenant-scoped | Tenant-scoped | |
| form_submissions | Tenant-scoped | Tenant-scoped | Tenant-scoped | Tenant-scoped | |
| tasks | Tenant-scoped | Tenant-scoped | Tenant-scoped | Tenant-scoped | |
| communications | Tenant-scoped | Tenant-scoped | Tenant-scoped | — | Append-only |
| message_templates | Tenant-scoped | Tenant-scoped | Tenant-scoped | Tenant-scoped | |
| notifications | Tenant-scoped | System only | Own (read/actioned) | — | |
| billing_plans | All tenants | God only | God only | God only | Shared table |
| subscriptions | Tenant-scoped | Tenant-scoped | Tenant-scoped | God only | |
| invoices | Tenant-scoped | System only | System only | — | |
| payments | Tenant-scoped | System only | — | — | |
| usage_records | Tenant-scoped | System only | — | — | Append-only |
| ai_requests | Tenant-scoped | Tenant-scoped | — | — | Append-only |
| embeddings | Tenant-scoped | System only | — | System only | |
| search_indexes | Tenant-scoped | System only | System only | System only | |
| audit_logs | Tenant-scoped (read) | System only | — | — | Immutable, chained |
| analytics_events | Tenant-scoped (read) | System only | — | — | Append-only |
| reports | Tenant-scoped | Tenant-scoped | Tenant-scoped | Tenant-scoped | |
| dashboards | Tenant-scoped | Tenant-scoped | Tenant-scoped | Tenant-scoped | |
| integration_adapters | All tenants (read) | God only | God only | God only | Shared table |
| api_call_logs | Tenant-scoped (read) | System only | — | — | Append-only |

---

## 14. Index Strategy

### 14.1 Index Type Selection Guide

| Query Pattern | Index Type | Example |
|---|---|---|
| Equality lookup (`WHERE col = ?`) | B-tree | `idx_users_email` |
| Range query (`WHERE col > ?`) | B-tree | `idx_cases_due` |
| Array containment (`WHERE roles @> ?`) | GIN | `idx_users_roles` |
| JSONB path (`WHERE attrs @> ?`) | GIN `jsonb_path_ops` | `idx_ue_vertical_attrs` |
| Full-text search (`WHERE tsv @@ ?`) | GIN | `idx_search_tsv` |
| Vector similarity (`ORDER BY emb <=> ?`) | IVFFlat | `idx_embeddings_vector` |
| Sorted with filter | Composite B-tree | `idx_cases_priority` |
| Partial (conditional) | Partial index | `idx_cases_due` (active only) |

### 14.2 Composite Index Strategy

Composite indexes should be ordered from most selective to least selective:

```sql
-- Good: tenant_id first (most selective), then status, then due_date
CREATE INDEX idx_cases_workflow ON cases (tenant_id, status, due_date);

-- Good: tenant-scoped lookup with sort
CREATE INDEX idx_audit_lookup ON audit_logs (tenant_id, event_type, created_at DESC);
```

### 14.3 JSONB GIN Indexes

All JSONB columns used in query filters need GIN indexes:

```sql
-- Already defined in table DDL above:
-- universal_entities.vertical_attributes
-- cases.case_data
-- workflow_instances.context
-- users.attributes
-- tenants.settings
```

### 14.4 Partial Indexes

For queries that always include a condition:

```sql
-- Active cases only (excludes closed/completed)
CREATE INDEX idx_cases_active ON cases (tenant_id, priority, due_date)
    WHERE status NOT IN ('closed', 'completed');

-- Pending OCR documents
CREATE INDEX idx_docs_pending_ocr ON documents (tenant_id, created_at)
    WHERE ocr_status = 'pending';

-- Active workflow instances
CREATE INDEX idx_wf_active ON workflow_instances (tenant_id, sla_deadline)
    WHERE status = 'active';

-- Unread notifications
CREATE INDEX idx_notifications_unread ON notifications (tenant_id, user_id, created_at DESC)
    WHERE is_read = FALSE;
```

### 14.5 Covering Indexes

For frequent queries that can be satisfied from the index alone:

```sql
-- Dashboard: active case counts by status
CREATE INDEX idx_cases_dashboard ON cases (tenant_id, status, priority)
    WHERE status != 'closed';

-- User task list
CREATE INDEX idx_tasks_user ON tasks (tenant_id, assigned_to, status, due_date)
    WHERE status NOT IN ('done', 'cancelled');
```

---

## 15. Partitioning & Data Lifecycle

### 15.1 Partitioning Strategy

High-volume append-only tables are partitioned by month:

```sql
-- audit_logs: partitioned by created_at (monthly)
CREATE TABLE audit_logs_partitioned (
    id UUID NOT NULL,
    tenant_id UUID NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID,
    actor_id UUID,
    actor_ip VARCHAR(45),
    actor_user_agent TEXT,
    action VARCHAR(255) NOT NULL,
    changes JSONB,
    previous_hash VARCHAR(64),
    current_hash VARCHAR(64) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Create monthly partitions
CREATE TABLE audit_logs_2026_05 PARTITION OF audit_logs_partitioned
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE audit_logs_2026_06 PARTITION OF audit_logs_partitioned
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Same pattern for: usage_records, analytics_events, api_call_logs, ai_requests
```

### 15.2 Data Retention Policy

| Table | Retention | Action | Rationale |
|---|---|---|---|
| audit_logs | 7 years | Archive to cold storage, then delete | Regulatory requirement |
| analytics_events | 2 years | Aggregate, then delete raw | BI window |
| usage_records | 3 years | Aggregate monthly, delete raw | Billing audit |
| api_call_logs | 1 year | Delete | Debugging only |
| ai_requests | 1 year | Anonymize, aggregate, delete raw | Cost analysis |
| notifications | 90 days | Delete read notifications | Noise reduction |
| sessions | 30 days after expiry | Delete | Security |

### 15.3 Archiving Procedure

```sql
-- Example: Archive audit_logs older than 2 years to S3, then delete
-- 1. Export to S3 via pg_dump or COPY
COPY (
    SELECT * FROM audit_logs
    WHERE created_at < NOW() - INTERVAL '2 years'
) TO PROGRAM 'aws s3 cp - s3://meru-archive/audit_logs_2024.csv';

-- 2. Verify export, then delete
DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '2 years';
```

---

## 16. JSONB Schema Definitions

### 16.1 tenants.settings

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "branding": {
      "type": "object",
      "properties": {
        "logo_url": { "type": "string", "format": "uri" },
        "favicon_url": { "type": "string", "format": "uri" },
        "primary_color": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "accent_color": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "font_family": { "type": "string" }
      }
    },
    "limits": {
      "type": "object",
      "properties": {
        "max_users": { "type": "integer" },
        "max_storage_gb": { "type": "integer" },
        "max_api_calls_per_minute": { "type": "integer" },
        "max_ai_tokens_per_month": { "type": "integer" }
      }
    },
    "features": {
      "type": "object",
      "properties": {
        "ai_enabled": { "type": "boolean" },
        "whatsapp_enabled": { "type": "boolean" },
        "sso_enabled": { "type": "boolean" },
        "api_access_enabled": { "type": "boolean" },
        "white_label_enabled": { "type": "boolean" }
      }
    }
  }
}
```

### 16.2 tenants.sso_config

```json
{
  "type": "object",
  "properties": {
    "provider": { "type": "string", "enum": ["saml", "oidc", "google", "azure_ad"] },
    "saml": {
      "type": "object",
      "properties": {
        "entry_point": { "type": "string", "format": "uri" },
        "issuer": { "type": "string" },
        "certificate": { "type": "string" },
        "name_id_format": { "type": "string" }
      }
    },
    "oidc": {
      "type": "object",
      "properties": {
        "client_id": { "type": "string" },
        "client_secret_encrypted": { "type": "string" },
        "issuer_url": { "type": "string", "format": "uri" },
        "scopes": { "type": "array", "items": { "type": "string" } }
      }
    },
    "attribute_mapping": {
      "type": "object",
      "properties": {
        "email": { "type": "string" },
        "first_name": { "type": "string" },
        "last_name": { "type": "string" },
        "roles": { "type": "string" }
      }
    }
  }
}
```

### 16.3 tenant_settings.branding

Same shape as `tenants.settings.branding` above, with additional:
```json
{
  "properties": {
    "portal_title": { "type": "string" },
    "login_background_url": { "type": "string" },
    "email_template_header_url": { "type": "string" },
    "dark_mode_primary_color": { "type": "string" },
    "dark_mode_accent_color": { "type": "string" }
  }
}
```

### 16.4 universal_entities.vertical_attributes

```json
{
  "type": "object",
  "description": "Vertical-specific attributes. Shape varies by entity_type and vertical.",
  "properties": {
    "immigration_applicant": {
      "type": "object",
      "properties": {
        "visa_type": { "type": "string" },
        "passport_number": { "type": "string" },
        "passport_country": { "type": "string" },
        "passport_expiry": { "type": "string", "format": "date" },
        "english_proficiency": {
          "type": "object",
          "properties": {
            "test_type": { "type": "string", "enum": ["IELTS", "TOEFL", "PTE"] },
            "score": { "type": "number" },
            "test_date": { "type": "string", "format": "date" }
          }
        },
        "dependents": { "type": "array" },
        "skills_assessment_ref": { "type": "string" }
      }
    },
    "banking_counterparty": {
      "type": "object",
      "properties": {
        "risk_level": { "type": "string", "enum": ["low", "medium", "high", "critical"] },
        "sanctions_status": { "type": "string", "enum": ["clear", "flagged", "escalated"] },
        "kyc_status": { "type": "string", "enum": ["pending", "in_progress", "verified", "rejected"] },
        "registration_number": { "type": "string" },
        "incorporation_country": { "type": "string" },
        "ubo_list": { "type": "array", "items": { "type": "object" } }
      }
    }
  }
}
```

### 16.5 cases.case_data

```json
{
  "type": "object",
  "description": "Vertical-specific case fields. Shape varies by case_type.",
  "properties": {
    "visa_482": {
      "type": "object",
      "properties": {
        "visa_subclass": { "type": "string" },
        "nomination_ref": { "type": "string" },
        "sponsor_entity_id": { "type": "string", "format": "uuid" },
        "position_title": { "type": "string" },
        "salary": { "type": "number" },
        "vevo_check_date": { "type": "string", "format": "date-time" },
        "vevo_status": { "type": "string" }
      }
    },
    "sanctions_check": {
      "type": "object",
      "properties": {
        "screening_reference": { "type": "string" },
        "lists_checked": { "type": "array", "items": { "type": "string" } },
        "match_count": { "type": "integer" },
        "false_positive_count": { "type": "integer" },
        "escalation_reason": { "type": "string" }
      }
    }
  }
}
```

### 16.6 documents.ai_analysis

```json
{
  "type": "object",
  "properties": {
    "document_type_detected": { "type": "string" },
    "extracted_data": { "type": "object" },
    "confidence_scores": {
      "type": "object",
      "properties": {
        "ocr": { "type": "number", "minimum": 0, "maximum": 100 },
        "classification": { "type": "number" },
        "extraction": { "type": "number" }
      }
    },
    "fraud_signals": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "signal_type": { "type": "string" },
          "confidence": { "type": "number" },
          "description": { "type": "string" }
        }
      }
    },
    "language_detected": { "type": "string" },
    "processed_at": { "type": "string", "format": "date-time" }
  }
}
```

### 16.7 - 16.11 schemas omitted for brevity (workflows.sla_config, workflow_transitions.conditions, workflow_transitions.actions, workflow_instances.context, sla_rules.escalation_steps, audit_logs.changes). Full schemas in [TRD.md](./TRD.md).

---

## 17. Migration & Versioning Strategy

### 17.1 Migration Tool

**Current**: TypeORM migrations (`typeorm migration:generate`)
**Target**: Drizzle Kit migrations (aligned with STRATEGY.md §7.5)

### 17.2 Migration Naming Convention

```
YYYYMMDDHHMMSS_descriptive_name.sql

Example:
20260528120000_add_sanctions_screening_tables.sql
20260601140000_add_rls_policies_documents.sql
```

### 17.3 Zero-Downtime Migration Rules

1. **Additive only on live tables**: New columns must have defaults or be nullable
2. **No renames**: Rename = add new + backfill + drop old in separate migrations
3. **No type changes**: Add new column, backfill, switch reads, drop old
4. **Indexes**: Create concurrently (`CREATE INDEX CONCURRENTLY`)
5. **Partitions**: Detach old, attach new partitions during low-traffic windows
6. **Backfill**: Use batched updates (10K rows at a time) with `sleep()` between batches

### 17.4 Migration CI Check

```bash
# Every PR must pass:
npm run typeorm migration:generate -- --check  # No uncommitted schema changes
npm run typeorm migration:run                   # Migrations apply cleanly against test DB
```

---

## 18. Connection & Pool Configuration

### 18.1 PgBouncer Configuration

```ini
[databases]
meru = host=localhost port=5432 dbname=meru

[pgbouncer]
pool_mode = transaction
max_client_conn = 500
default_pool_size = 30
reserve_pool_size = 10
reserve_pool_timeout = 5
max_db_connections = 100
```

### 18.2 Application Connection Pool

```typescript
// TypeORM DataSource configuration (per vertical deployment)
{
  type: 'postgres',
  host: 'pgbouncer',          // Connect through PgBouncer
  port: 6432,
  extra: {
    max: 20,                   // Max connections in pool
    min: 2,                    // Min idle connections
    idleTimeoutMillis: 30000,  // 30s idle timeout
    connectionTimeoutMillis: 5000,
  },
}
```

---

## 19. Backup & Recovery

### 19.1 Backup Schedule

| Type | Frequency | Retention | Tool |
|---|---|---|---|
| Full (pg_dump) | Daily | 30 days | `pg_dump -Fc` |
| WAL Archiving | Continuous | 7 days | `archive_command` |
| Incremental | Hourly | 24 hours | WAL-based PITR |
| Offsite | Daily | 90 days | S3 cross-region replication |

### 19.2 Point-in-Time Recovery

```bash
# Restore to specific point in time
pgbackrest --stanza=meru restore \
  --type=time \
  --target="2026-05-28 14:30:00+04" \
  --target-action=promote
```

### 19.3 Backup Verification

- Automated restore test weekly against staging environment
- Checksum verification on all backups
- Alert if backup fails two consecutive runs

---

## Appendix A: Complete Table Inventory

| # | Table | Module | RLS | Partitioned | Soft Delete | Notes |
|---|---|---|---|---|---|---|
| 1 | tenants | IAM | Yes | No | Yes | Central multi-tenancy |
| 2 | users | IAM | Yes | No | Yes | Per-tenant users |
| 3 | roles | IAM | Yes | No | No | Per-tenant RBAC |
| 4 | sessions | IAM | Yes | No | No | JWT session tracking |
| 5 | api_keys | IAM | Yes | No | No | M2M authentication |
| 6 | tenant_settings | TCM | Yes | No | No | 1:1 with tenants |
| 7 | feature_flags | TCM | Yes | No | No | Gradual rollouts |
| 8 | config_packs | TCM | Shared | No | No | JSON config registry |
| 9 | tenant_config_pins | TCM | Yes | No | No | Version pinning |
| 10 | universal_entities | CRM | Yes | No | Yes | Polymorphic entity table |
| 11 | entity_relationships | CRM | Yes | No | No | Graph relationships |
| 12 | cases | CRM | Yes | No | Yes | Core work items |
| 13 | notes | CRM | Yes | No | No | Free-text annotations |
| 14 | tags | CRM | Yes | No | No | Classification |
| 15 | entity_tags | CRM | Yes | No | No | Many-to-many junction |
| 16 | documents | DOC | Yes | No | Yes | File metadata |
| 17 | document_versions | DOC | Yes | No | No | Version history |
| 18 | workflows | WF | Yes | No | No | BPMN definitions |
| 19 | workflow_states | WF | Yes | No | No | State definitions |
| 20 | workflow_transitions | WF | Yes | No | No | Transition rules |
| 21 | workflow_instances | WF | Yes | No | No | Active process instances |
| 22 | workflow_history | WF | Yes | No | No | Immutable transition log |
| 23 | sla_rules | WF | Yes | No | No | Escalation configuration |
| 24 | form_schemas | FORM | Yes | No | No | JSON Schema forms |
| 25 | form_fields | FORM | Yes | No | No | Field definitions |
| 26 | form_submissions | FORM | Yes | No | No | Submitted data |
| 27 | tasks | TASK | Yes | No | Yes | Work items |
| 28 | task_dependencies | TASK | Yes | No | No | Dependency graph |
| 29 | communications | COM | Yes | No | No | Multi-channel messages |
| 30 | message_templates | COM | Yes | No | No | Templated messages |
| 31 | notifications | COM | Yes | No | No | In-app notifications |
| 32 | billing_plans | BILL | Shared | No | No | Plan definitions |
| 33 | subscriptions | BILL | Yes | No | No | Tenant subscriptions |
| 34 | invoices | BILL | Yes | No | No | Billing documents |
| 35 | invoice_items | BILL | Yes | No | No | Line items |
| 36 | payments | BILL | Yes | No | No | Payment records |
| 37 | usage_records | BILL | Yes | Monthly | No | Metered usage |
| 38 | ai_requests | AI | Yes | Monthly | No | AI call audit |
| 39 | ai_responses | AI | Yes | No | No | AI response store |
| 40 | embeddings | AI | Yes | No | No | Vector embeddings |
| 41 | search_indexes | SRCH | Yes | No | No | FTS vectors |
| 42 | audit_logs | AUD | Yes | Monthly | No | Hash-chained, immutable |
| 43 | analytics_events | BI | Yes | Monthly | No | Raw event stream |
| 44 | reports | BI | Yes | No | No | Saved report configs |
| 45 | dashboards | BI | Yes | No | No | Dashboard layouts |
| 46 | integration_adapters | INT | Shared | No | No | Gov API registry |
| 47 | api_call_logs | INT | Yes | Monthly | No | Gov API audit trail |

---

*Last updated: 2026-05-28*
*Document owner: Meru Platform Team*
