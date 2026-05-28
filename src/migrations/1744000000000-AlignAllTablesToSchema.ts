import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

export class AlignAllTablesToSchema1744000000000 implements MigrationInterface {
  name = 'AlignAllTablesToSchema1744000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // =========================================================================
    // PHASE 1: Add missing UUID tenant_id columns and normalize existing tables
    // =========================================================================

    // 1.1 Normalize tenants table to match DATABASE_SCHEMA.md
    await queryRunner.query(`
      ALTER TABLE tenants
        ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS industry VARCHAR(100),
        ADD COLUMN IF NOT EXISTS region VARCHAR(50),
        ADD COLUMN IF NOT EXISTS country VARCHAR(3),
        ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS sso_config JSONB,
        ADD COLUMN IF NOT EXISTS billing_plan_id UUID,
        ADD COLUMN IF NOT EXISTS is_god_mode BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
    `);

    // 1.2 Normalize users table
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS first_name VARCHAR(100),
        ADD COLUMN IF NOT EXISTS last_name VARCHAR(100),
        ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(500),
        ADD COLUMN IF NOT EXISTS attributes JSONB NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
    `);

    // 1.3 Normalize tenant_settings
    await queryRunner.query(`
      ALTER TABLE tenant_settings
        ADD COLUMN IF NOT EXISTS branding JSONB NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS localization JSONB NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS security_policies JSONB NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    // =========================================================================
    // PHASE 2: Create all missing tables per DATABASE_SCHEMA.md
    // =========================================================================

    // 2.1 roles
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        name VARCHAR(100) NOT NULL,
        description TEXT,
        permissions JSONB NOT NULL DEFAULT '[]',
        is_system BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_roles_tenant ON roles (tenant_id);
    `);

    // 2.2 sessions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        user_id UUID NOT NULL REFERENCES users(id),
        token_hash VARCHAR(128) NOT NULL UNIQUE,
        refresh_token_hash VARCHAR(128),
        ip_address VARCHAR(45),
        user_agent TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions (tenant_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token_hash);
    `);

    // 2.3 api_keys
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        name VARCHAR(255) NOT NULL,
        key_hash VARCHAR(128) NOT NULL UNIQUE,
        prefix VARCHAR(8) NOT NULL,
        scopes TEXT[] NOT NULL DEFAULT '{}',
        last_used_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_by UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);
    `);

    // 2.4 feature_flags
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS feature_flags (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        flag_key VARCHAR(100) NOT NULL,
        flag_value JSONB NOT NULL DEFAULT 'true',
        description TEXT,
        rollout_percentage INTEGER DEFAULT 100,
        target_roles TEXT[],
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, flag_key)
      );
      CREATE INDEX IF NOT EXISTS idx_feature_flags_tenant ON feature_flags (tenant_id);
    `);

    // 2.5 config_packs
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS config_packs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code VARCHAR(100) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        version VARCHAR(20) NOT NULL,
        vertical VARCHAR(50),
        schema JSONB NOT NULL DEFAULT '{}',
        defaults JSONB NOT NULL DEFAULT '{}',
        ui_config JSONB NOT NULL DEFAULT '{}',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_config_packs_code ON config_packs (code);
      CREATE INDEX IF NOT EXISTS idx_config_packs_vertical ON config_packs (vertical);
    `);

    // 2.6 tenant_config_pins
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tenant_config_pins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        config_pack_id UUID NOT NULL REFERENCES config_packs(id),
        pinned_version VARCHAR(20) NOT NULL,
        overrides JSONB NOT NULL DEFAULT '{}',
        pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pinned_by UUID REFERENCES users(id),
        UNIQUE (tenant_id, config_pack_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tenant_config_pins_tenant ON tenant_config_pins (tenant_id);
    `);

    // 2.7 cases
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS cases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        case_number VARCHAR(50) NOT NULL,
        case_type VARCHAR(50) NOT NULL,
        title VARCHAR(500) NOT NULL,
        description TEXT,
        status VARCHAR(30) NOT NULL DEFAULT 'open',
        priority VARCHAR(20) NOT NULL DEFAULT 'medium',
        assigned_to UUID REFERENCES users(id),
        case_data JSONB NOT NULL DEFAULT '{}',
        metadata JSONB NOT NULL DEFAULT '{}',
        due_date TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        created_by UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_number ON cases (tenant_id, case_number);
      CREATE INDEX IF NOT EXISTS idx_cases_tenant ON cases (tenant_id);
      CREATE INDEX IF NOT EXISTS idx_cases_status ON cases (tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_cases_priority ON cases (tenant_id, priority, due_date);
      CREATE INDEX IF NOT EXISTS idx_cases_assigned ON cases (assigned_to);
      CREATE INDEX IF NOT EXISTS idx_cases_data ON cases USING GIN (case_data);
      CREATE INDEX IF NOT EXISTS idx_cases_active ON cases (tenant_id, priority, due_date)
        WHERE status NOT IN ('closed', 'completed');
    `);

    // 2.8 notes
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS notes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        entity_type VARCHAR(50) NOT NULL,
        entity_id UUID NOT NULL,
        content TEXT NOT NULL,
        is_internal BOOLEAN NOT NULL DEFAULT FALSE,
        created_by UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_notes_tenant ON notes (tenant_id);
      CREATE INDEX IF NOT EXISTS idx_notes_entity ON notes (entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_notes_created ON notes (created_by);
    `);

    // 2.9 tags
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tags (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        name VARCHAR(100) NOT NULL,
        color VARCHAR(7),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_tags_tenant ON tags (tenant_id);
    `);

    // 2.10 entity_tags
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS entity_tags (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        entity_type VARCHAR(50) NOT NULL,
        entity_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tag_id, entity_type, entity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_entity_tags_tenant ON entity_tags (tenant_id);
      CREATE INDEX IF NOT EXISTS idx_entity_tags_entity ON entity_tags (entity_type, entity_id);
    `);

    // 2.11 entity_relationships
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS entity_relationships (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        source_type VARCHAR(50) NOT NULL,
        source_id UUID NOT NULL,
        target_type VARCHAR(50) NOT NULL,
        target_id UUID NOT NULL,
        relationship_type VARCHAR(50) NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_er_tenant ON entity_relationships (tenant_id);
      CREATE INDEX IF NOT EXISTS idx_er_source ON entity_relationships (source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_er_target ON entity_relationships (target_type, target_id);
    `);

    // 2.12 documents
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        file_name VARCHAR(500) NOT NULL,
        file_path VARCHAR(1000) NOT NULL,
        file_size BIGINT NOT NULL,
        mime_type VARCHAR(100) NOT NULL,
        document_type VARCHAR(50),
        storage_provider VARCHAR(30) NOT NULL DEFAULT 'supabase',
        storage_bucket VARCHAR(100) NOT NULL,
        storage_key VARCHAR(1000) NOT NULL,
        ocr_status VARCHAR(30) NOT NULL DEFAULT 'pending',
        ocr_text TEXT,
        ai_analysis JSONB,
        tags TEXT[] NOT NULL DEFAULT '{}',
        metadata JSONB NOT NULL DEFAULT '{}',
        checksum_sha256 VARCHAR(64),
        is_encrypted BOOLEAN NOT NULL DEFAULT FALSE,
        encryption_key_ref VARCHAR(255),
        deleted_at TIMESTAMPTZ,
        uploaded_by UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_documents_tenant ON documents (tenant_id);
      CREATE INDEX IF NOT EXISTS idx_documents_type ON documents (tenant_id, document_type);
      CREATE INDEX IF NOT EXISTS idx_documents_ocr ON documents (tenant_id, ocr_status);
      CREATE INDEX IF NOT EXISTS idx_documents_pending_ocr ON documents (tenant_id, created_at)
        WHERE ocr_status = 'pending';
    `);

    // 2.13 document_versions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS document_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        storage_key VARCHAR(1000) NOT NULL,
        file_size BIGINT NOT NULL,
        checksum_sha256 VARCHAR(64),
        change_notes TEXT,
        uploaded_by UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (document_id, version_number)
      );
      CREATE INDEX IF NOT EXISTS idx_doc_versions_doc ON document_versions (document_id);
    `);

    // 2.14 workflow_states
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS workflow_states (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        display_name VARCHAR(255) NOT NULL,
        state_type VARCHAR(30) NOT NULL DEFAULT 'task',
        sla_duration_hours INTEGER,
        form_schema_id UUID,
        assignment_rules JSONB NOT NULL DEFAULT '{}',
        metadata JSONB NOT NULL DEFAULT '{}',
        position_x FLOAT DEFAULT 0,
        position_y FLOAT DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_wf_states_workflow ON workflow_states (workflow_id);
    `);

    // 2.15 workflow_transitions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS workflow_transitions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        from_state_id UUID NOT NULL REFERENCES workflow_states(id) ON DELETE CASCADE,
        to_state_id UUID NOT NULL REFERENCES workflow_states(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        transition_type VARCHAR(30) NOT NULL DEFAULT 'manual',
        conditions JSONB NOT NULL DEFAULT '{}',
        actions JSONB NOT NULL DEFAULT '[]',
        is_automatic BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_wf_transitions_workflow ON workflow_transitions (workflow_id);
      CREATE INDEX IF NOT EXISTS idx_wf_transitions_from ON workflow_transitions (from_state_id);
    `);

    // 2.16 workflow_instances
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS workflow_instances (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        workflow_id UUID NOT NULL REFERENCES workflows(id),
        case_id UUID REFERENCES cases(id),
        current_state_id UUID REFERENCES workflow_states(id),
        status VARCHAR(30) NOT NULL DEFAULT 'active',
        context JSONB NOT NULL DEFAULT '{}',
        sla_deadline TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        started_by UUID REFERENCES users(id),
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_wfi_tenant ON workflow_instances (tenant_id);
      CREATE INDEX IF NOT EXISTS idx_wfi_workflow ON workflow_instances (workflow_id);
      CREATE INDEX IF NOT EXISTS idx_wfi_case ON workflow_instances (case_id);
      CREATE INDEX IF NOT EXISTS idx_wfi_status ON workflow_instances (tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_wfi_context ON workflow_instances USING GIN (context);
      CREATE INDEX IF NOT EXISTS idx_wfi_active ON workflow_instances (tenant_id, sla_deadline)
        WHERE status = 'active';
    `);

    // 2.17 workflow_history
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS workflow_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        workflow_instance_id UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
        transition_id UUID REFERENCES workflow_transitions(id),
        from_state_id UUID REFERENCES workflow_states(id),
        to_state_id UUID REFERENCES workflow_states(id),
        action VARCHAR(100) NOT NULL,
        comment TEXT,
        metadata JSONB NOT NULL DEFAULT '{}',
        performed_by UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_wf_history_instance ON workflow_history (workflow_instance_id);
      CREATE INDEX IF NOT EXISTS idx_wf_history_tenant ON workflow_history (tenant_id);
    `);

    // 2.18 sla_rules
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sla_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        name VARCHAR(255) NOT NULL,
        applies_to VARCHAR(50) NOT NULL,
        condition JSONB NOT NULL DEFAULT '{}',
        duration_hours INTEGER NOT NULL,
        severity VARCHAR(20) NOT NULL DEFAULT 'warning',
        escalation_steps JSONB NOT NULL DEFAULT '[]',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_sla_rules_tenant ON sla_rules (tenant_id);
    `);

    // 2.19 form_schemas
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS form_schemas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        schema JSONB NOT NULL DEFAULT '{}',
        ui_schema JSONB NOT NULL DEFAULT '{}',
        is_published BOOLEAN NOT NULL DEFAULT FALSE,
        created_by UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_form_schemas_tenant ON form_schemas (tenant_id);
    `);

    // 2.20 form_fields
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS form_fields (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        form_schema_id UUID NOT NULL REFERENCES form_schemas(id) ON DELETE CASCADE,
        field_key VARCHAR(100) NOT NULL,
        field_type VARCHAR(50) NOT NULL,
        label VARCHAR(255) NOT NULL,
        placeholder VARCHAR(500),
        help_text TEXT,
        default_value JSONB,
        validators JSONB NOT NULL DEFAULT '{}',
        conditional_logic JSONB,
        field_order INTEGER NOT NULL DEFAULT 0,
        is_required BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (form_schema_id, field_key)
      );
      CREATE INDEX IF NOT EXISTS idx_form_fields_schema ON form_fields (form_schema_id);
    `);

    // 2.21 form_submissions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS form_submissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        form_schema_id UUID NOT NULL REFERENCES form_schemas(id),
        case_id UUID REFERENCES cases(id),
        entity_id UUID REFERENCES universal_entities(id),
        data JSONB NOT NULL DEFAULT '{}',
        status VARCHAR(30) NOT NULL DEFAULT 'draft',
        submitted_by UUID REFERENCES users(id),
        submitted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_form_submissions_tenant ON form_submissions (tenant_id);
      CREATE INDEX IF NOT EXISTS idx_form_submissions_form ON form_submissions (form_schema_id);
      CREATE INDEX IF NOT EXISTS idx_form_submissions_case ON form_submissions (case_id);
    `);

    // 2.22 task_dependencies
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS task_dependencies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        dependency_type VARCHAR(30) NOT NULL DEFAULT 'blocking',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (task_id, depends_on_task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_deps_tenant ON task_dependencies (tenant_id);
      CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies (task_id);
    `);

    // 2.23 communications
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS communications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        channel VARCHAR(30) NOT NULL,
        direction VARCHAR(10) NOT NULL DEFAULT 'outbound',
        sender_address VARCHAR(500),
        recipient_address VARCHAR(500),
        subject VARCHAR(500),
        body TEXT,
        meta JSONB NOT NULL DEFAULT '{}',
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        case_id UUID REFERENCES cases(id),
        entity_id UUID REFERENCES universal_entities(id),
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_comms_tenant ON communications (tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_comms_case ON communications (case_id);
      CREATE INDEX IF NOT EXISTS idx_comms_status ON communications (tenant_id, status);
    `);

    // 2.24 message_templates
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS message_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        name VARCHAR(255) NOT NULL,
        template_key VARCHAR(100) NOT NULL,
        channel VARCHAR(30) NOT NULL,
        subject_template VARCHAR(500),
        body_template TEXT NOT NULL,
        variables JSONB NOT NULL DEFAULT '{}',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, template_key)
      );
      CREATE INDEX IF NOT EXISTS idx_msg_templates_tenant ON message_templates (tenant_id);
    `);

    // 2.25 notifications
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        user_id UUID NOT NULL REFERENCES users(id),
        notification_type VARCHAR(50) NOT NULL,
        title VARCHAR(500) NOT NULL,
        body TEXT,
        data JSONB NOT NULL DEFAULT '{}',
        action_url VARCHAR(1000),
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        is_actioned BOOLEAN NOT NULL DEFAULT FALSE,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_tenant ON notifications (tenant_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (tenant_id, user_id, created_at DESC)
        WHERE is_read = FALSE;
    `);

    // 2.26 payments
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        invoice_id UUID REFERENCES invoices(id),
        amount DECIMAL(12,2) NOT NULL,
        currency VARCHAR(3) NOT NULL DEFAULT 'AED',
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        payment_method VARCHAR(50),
        stripe_payment_intent_id VARCHAR(255),
        error_message TEXT,
        refunded_amount DECIMAL(12,2),
        refunded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments (tenant_id);
      CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments (invoice_id);
      CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (tenant_id, status);
    `);

    // 2.27 ai_requests
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ai_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        user_id UUID NOT NULL REFERENCES users(id),
        model VARCHAR(100) NOT NULL,
        provider VARCHAR(50) NOT NULL,
        messages JSONB NOT NULL,
        parameters JSONB NOT NULL DEFAULT '{}',
        citations JSONB,
        token_count_input INTEGER,
        token_count_output INTEGER,
        cost DECIMAL(12,6),
        latency_ms INTEGER,
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        error_message TEXT,
        case_id UUID REFERENCES cases(id),
        entity_id UUID REFERENCES universal_entities(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ai_requests_tenant ON ai_requests (tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_requests_user ON ai_requests (tenant_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_ai_requests_model ON ai_requests (tenant_id, model, created_at DESC);
    `);

    // 2.28 ai_responses
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ai_responses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id UUID NOT NULL REFERENCES ai_requests(id) ON DELETE CASCADE UNIQUE,
        content TEXT NOT NULL,
        citations JSONB,
        finish_reason VARCHAR(30),
        tool_calls JSONB,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ai_responses_request ON ai_responses (request_id);
    `);

    // 2.29 embeddings (requires pgvector extension)
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        source_type VARCHAR(50) NOT NULL,
        source_id UUID NOT NULL,
        model VARCHAR(100) NOT NULL,
        embedding VECTOR(1536),
        chunk_index INTEGER NOT NULL DEFAULT 0,
        chunk_text TEXT,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings (source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_embeddings_tenant ON embeddings (tenant_id);
    `);

    // 2.30 search_indexes
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS search_indexes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        source_type VARCHAR(50) NOT NULL,
        source_id UUID NOT NULL,
        title VARCHAR(500),
        content_text TEXT,
        tsv TSVECTOR,
        indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, source_type, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_search_tenant ON search_indexes (tenant_id);
      CREATE INDEX IF NOT EXISTS idx_search_tsv ON search_indexes USING GIN (tsv);
      CREATE INDEX IF NOT EXISTS idx_search_source ON search_indexes (source_type, source_id);
    `);

    // 2.31 analytics_events
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        event_name VARCHAR(100) NOT NULL,
        event_category VARCHAR(50),
        user_id UUID REFERENCES users(id),
        entity_type VARCHAR(50),
        entity_id UUID,
        properties JSONB NOT NULL DEFAULT '{}',
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_tenant ON analytics_events (tenant_id, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics_events (tenant_id, event_name, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_analytics_category ON analytics_events (tenant_id, event_category, recorded_at DESC);
    `);

    // 2.32 dashboards (separate from dashboard_widgets per schema)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS dashboards (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        user_id UUID REFERENCES users(id),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        layout JSONB NOT NULL DEFAULT '[]',
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        is_shared BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, user_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_dashboards_tenant ON dashboards (tenant_id);
    `);

    // 2.33 integration_adapters
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS integration_adapters (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code VARCHAR(100) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        country VARCHAR(3) NOT NULL,
        regulator VARCHAR(255) NOT NULL,
        base_url VARCHAR(500) NOT NULL,
        auth_type VARCHAR(30) NOT NULL DEFAULT 'api_key',
        auth_config JSONB NOT NULL DEFAULT '{}',
        rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
        timeout_ms INTEGER NOT NULL DEFAULT 30000,
        retry_config JSONB NOT NULL DEFAULT '{}',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        health_status VARCHAR(30) DEFAULT 'unknown',
        last_health_check TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2.34 api_call_logs
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS api_call_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        adapter_id UUID NOT NULL REFERENCES integration_adapters(id),
        endpoint VARCHAR(500) NOT NULL,
        method VARCHAR(10) NOT NULL,
        request_headers JSONB,
        request_body JSONB,
        response_status INTEGER,
        response_body JSONB,
        latency_ms INTEGER,
        error_message TEXT,
        idempotency_key VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_api_logs_tenant ON api_call_logs (tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_api_logs_adapter ON api_call_logs (adapter_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_api_logs_status ON api_call_logs (adapter_id, response_status, created_at DESC);
    `);

    // =========================================================================
    // PHASE 3: Add search TSVECTOR trigger function
    // =========================================================================
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_search_tsv()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.tsv := to_tsvector('english', COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.content_text, ''));
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_search_tsv ON search_indexes;
      CREATE TRIGGER trg_search_tsv
        BEFORE INSERT OR UPDATE ON search_indexes
        FOR EACH ROW EXECUTE FUNCTION update_search_tsv();
    `);

    // =========================================================================
    // PHASE 4: RLS Policies for all new tables
    // =========================================================================

    const rlsTables = [
      'roles', 'sessions', 'api_keys', 'feature_flags', 'tenant_config_pins',
      'cases', 'notes', 'tags', 'entity_tags', 'entity_relationships',
      'documents', 'document_versions',
      'workflow_states', 'workflow_transitions', 'workflow_instances', 'workflow_history',
      'sla_rules', 'form_schemas', 'form_fields', 'form_submissions',
      'task_dependencies', 'communications', 'message_templates', 'notifications',
      'payments', 'ai_requests', 'ai_responses', 'embeddings',
      'search_indexes', 'analytics_events', 'dashboards', 'api_call_logs',
    ];

    for (const table of rlsTables) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = '${table}'
          ) THEN
            EXECUTE 'CREATE POLICY tenant_isolation ON ${table}
              FOR ALL
              TO authenticated
              USING (tenant_id = current_setting(''app.current_tenant_id'')::UUID)
              WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'')::UUID)';
          END IF;
        END;
        $$;
      `);
    }

    // Shared read tables (config_packs, integration_adapters)
    for (const table of ['config_packs', 'integration_adapters']) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_policies WHERE policyname = 'shared_read' AND tablename = '${table}'
          ) THEN
            EXECUTE 'CREATE POLICY shared_read ON ${table}
              FOR SELECT TO authenticated USING (TRUE)';
          END IF;
        END;
        $$;
      `);
    }

    // =========================================================================
    // PHASE 5: Add composite indexes from index strategy
    // =========================================================================
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_cases_workflow ON cases (tenant_id, status, due_date);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks (tenant_id, assigned_to, status, due_date)
        WHERE status NOT IN ('done', 'cancelled');
    `);

    // =========================================================================
    // PHASE 6: Add triggers for updated_at auto-setting
    // =========================================================================
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    const autoUpdateTables = [
      'roles', 'feature_flags', 'config_packs', 'tenant_config_pins',
      'cases', 'notes', 'documents', 'sla_rules',
      'form_schemas', 'form_submissions', 'message_templates',
      'workflow_instances', 'dashboards', 'integration_adapters',
    ];

    for (const table of autoUpdateTables) {
      const triggerName = `trg_${table}_updated_at`;
      await queryRunner.query(`
        DROP TRIGGER IF EXISTS ${triggerName} ON ${table};
        CREATE TRIGGER ${triggerName}
          BEFORE UPDATE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse order: triggers, policies, tables

    const autoUpdateTables = [
      'roles', 'feature_flags', 'config_packs', 'tenant_config_pins',
      'cases', 'notes', 'documents', 'sla_rules',
      'form_schemas', 'form_submissions', 'message_templates',
      'workflow_instances', 'dashboards', 'integration_adapters',
    ];

    for (const table of autoUpdateTables) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS trg_${table}_updated_at ON ${table}`);
    }

    await queryRunner.query(`DROP FUNCTION IF EXISTS set_updated_at CASCADE`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_search_tsv ON search_indexes`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS update_search_tsv CASCADE`);
    await queryRunner.query(`DROP EXTENSION IF EXISTS vector CASCADE`);

    const tablesToDrop = [
      'api_call_logs', 'integration_adapters',
      'dashboards', 'analytics_events',
      'search_indexes', 'embeddings',
      'ai_responses', 'ai_requests',
      'payments',
      'notifications', 'message_templates', 'communications',
      'task_dependencies',
      'form_submissions', 'form_fields', 'form_schemas',
      'sla_rules', 'workflow_history', 'workflow_instances',
      'workflow_transitions', 'workflow_states',
      'document_versions', 'documents',
      'entity_relationships', 'entity_tags', 'tags', 'notes', 'cases',
      'tenant_config_pins', 'config_packs',
      'feature_flags', 'api_keys', 'sessions', 'roles',
    ];

    for (const table of tablesToDrop) {
      await queryRunner.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
  }
}