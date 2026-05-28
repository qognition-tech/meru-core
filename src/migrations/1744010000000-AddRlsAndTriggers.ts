import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRlsAndTriggers1744010000000 implements MigrationInterface {
  name = 'AddRlsAndTriggers1744010000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // =========================================================================
    // 1. AUDIT TRIGGER FUNCTION — auto-logs INSERT/UPDATE/DELETE on key tables
    // =========================================================================
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION audit_trigger_function()
      RETURNS TRIGGER AS $$
      DECLARE
        audit_row audit_logs;
        include_values BOOLEAN;
        log_diffs BOOLEAN;
        h_old JSONB;
        h_new JSONB;
        excluded_cols TEXT[] = ARRAY[]::TEXT[];
      BEGIN
        IF TG_WHEN <> 'AFTER' THEN
          RAISE EXCEPTION 'audit_trigger_function() may only run as an AFTER trigger';
        END IF;

        audit_row = ROW(
          gen_random_uuid(),            -- id
          COALESCE(NEW->>'tenant_id', OLD->>'tenant_id'),  -- tenant_id
          TG_TABLE_NAME::VARCHAR(100),   -- table_name
          TG_OP,                        -- operation
          OLD->>'id',                   -- record_id
          COALESCE(NEW->>'id', OLD->>'id')::UUID, -- entity_id
          current_setting('meru.current_user_id', true), -- actor_id
          jsonb_build_object(           -- changes
            'old', to_jsonb(OLD),
            'new', to_jsonb(NEW)
          ),
          current_setting('meru.request_id', true),  -- request_id
          inet_client_addr()::TEXT       -- ip_address
        );

        INSERT INTO audit_logs VALUES (audit_row.*);
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `);

    // Apply audit triggers to core tenant-scoped tables
    const auditTables = [
      'tenants', 'users', 'roles', 'sessions', 'api_keys',
      'universal_entities', 'cases', 'notes',
      'documents', 'document_versions',
      'tasks', 'task_comments',
      'workflows', 'workflow_instances',
      'form_schemas', 'form_submissions',
      'subscriptions', 'invoices',
      'reports', 'notification_templates',
      'config_packs', 'feature_flags',
      'integration_instances',
    ];

    for (const table of auditTables) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit_${table}'
          ) THEN
            CREATE TRIGGER trg_audit_${table}
              AFTER INSERT OR UPDATE OR DELETE ON ${table}
              FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();
          END IF;
        END $$;
      `);
    }

    // =========================================================================
    // 2. COMPOSITE INDEXES for multi-tenant query performance
    // =========================================================================

    // IAM indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_users_tenant_status ON users(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email));
      CREATE INDEX IF NOT EXISTS idx_roles_tenant ON roles(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    `);

    // CRM indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_universal_entities_type ON universal_entities(entity_type);
      CREATE INDEX IF NOT EXISTS idx_universal_entities_status ON universal_entities(status);
      CREATE INDEX IF NOT EXISTS idx_universal_entities_search ON universal_entities USING GIN (search_vector);
      CREATE INDEX IF NOT EXISTS idx_cases_status_priority ON cases(tenant_id, status, priority);
      CREATE INDEX IF NOT EXISTS idx_cases_assigned ON cases(assigned_to);
      CREATE INDEX IF NOT EXISTS idx_cases_due ON cases(due_date) WHERE status != 'resolved';
      CREATE INDEX IF NOT EXISTS idx_notes_entity ON notes(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_entity_tags_entity ON entity_tags(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(tag_id);
    `);

    // Document indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(tenant_id, category);
      CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_documents_search ON documents USING GIN (search_vector);
      CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(tenant_id, mime_type);
      CREATE INDEX IF NOT EXISTS idx_document_versions_doc ON document_versions(document_id);
    `);

    // Workflow indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_workflows_entity ON workflows(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_instances_status ON workflow_instances(workflow_id, status);
      CREATE INDEX IF NOT EXISTS idx_workflow_instances_assignee ON workflow_instances(current_assignee);
      CREATE INDEX IF NOT EXISTS idx_workflow_states_workflow ON workflow_states(workflow_id);
    `);

    // Task indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(assignee_id, status, due_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_entity ON tasks(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_search ON tasks USING GIN (search_vector);
      CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);
    `);

    // Form indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_form_schemas_tenant ON form_schemas(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_form_submissions_form ON form_submissions(form_schema_id);
      CREATE INDEX IF NOT EXISTS idx_form_submissions_tenant ON form_submissions(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_form_fields_schema ON form_fields(form_schema_id);
    `);

    // Billing indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
      CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_usage_records_tenant ON usage_records(tenant_id, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_credit_ledger_tenant ON credit_ledger(tenant_id);
    `);

    // Analytics indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_reports_tenant ON reports(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_report_executions_report ON report_executions(report_id);
      CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_dashboard ON dashboard_widgets(dashboard_id);
    `);

    // Notification indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
      CREATE INDEX IF NOT EXISTS idx_notifications_tenant ON notifications(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notification_templates_tenant ON notification_templates(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_email_logs_tenant ON email_logs(tenant_id, created_at DESC);
    `);

    // Config indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_config_packs_code ON config_packs(code);
      CREATE INDEX IF NOT EXISTS idx_config_versions_pack ON config_versions(config_pack_id, version);
      CREATE INDEX IF NOT EXISTS idx_feature_flags_tenant ON feature_flags(tenant_id, flag_key);
      CREATE INDEX IF NOT EXISTS idx_tenant_config_pins_tenant ON tenant_config_pins(tenant_id, config_pack_id);
    `);

    // Integration indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_integration_instances_tenant ON integration_instances(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_integration_instances_adapter ON integration_instances(adapter_id);
    `);

    // Search indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_search_keywords_tenant ON search_keywords(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_search_analytics_tenant ON search_analytics(tenant_id, searched_at);
    `);

    // Queue indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON queue_jobs(status, priority DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_scheduled ON queue_jobs(scheduled_at) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_job_logs_job ON queue_job_logs(job_id);
    `);

    // Storage indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_storage_files_tenant ON storage_files(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_storage_files_parent ON storage_files(parent_id);
      CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id);
    `);

    // Elasticsearch indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_es_documents_index ON elasticsearch_documents(index_id);
      CREATE INDEX IF NOT EXISTS idx_es_search_logs ON elasticsearch_search_logs(tenant_id, searched_at);
    `);

    // =========================================================================
    // 3. FULL-TEXT SEARCH VECTORS with GIN indexes on core tables
    // =========================================================================

    // Add search_vector columns if not exist (on core searchable tables)
    await queryRunner.query(`
      ALTER TABLE universal_entities ADD COLUMN IF NOT EXISTS search_vector tsvector;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS search_vector tsvector;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS search_vector tsvector;
      ALTER TABLE cases ADD COLUMN IF NOT EXISTS search_vector tsvector;
    `);

    // Create/update triggers to auto-populate search_vector
    // universal_entities
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION universal_entities_search_update() RETURNS TRIGGER AS $$
      BEGIN
        NEW.search_vector :=
          setweight(to_tsvector('english', COALESCE(NEW.entity_type, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(NEW.entity_data->>'title', '')), 'B') ||
          setweight(to_tsvector('english', COALESCE(NEW.entity_data->>'description', '')), 'C');
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_universal_entities_search ON universal_entities;
      CREATE TRIGGER trg_universal_entities_search
        BEFORE INSERT OR UPDATE ON universal_entities
        FOR EACH ROW EXECUTE FUNCTION universal_entities_search_update();
    `);

    // documents
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION documents_search_update() RETURNS TRIGGER AS $$
      BEGIN
        NEW.search_vector :=
          setweight(to_tsvector('english', COALESCE(NEW.file_name, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(NEW.content_text, '')), 'B') ||
          setweight(to_tsvector('english', COALESCE(NEW.tags::TEXT, '')), 'C');
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_documents_search ON documents;
      CREATE TRIGGER trg_documents_search
        BEFORE INSERT OR UPDATE ON documents
        FOR EACH ROW EXECUTE FUNCTION documents_search_update();
    `);

    // tasks
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION tasks_search_update() RETURNS TRIGGER AS $$
      BEGIN
        NEW.search_vector :=
          setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B');
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_tasks_search ON tasks;
      CREATE TRIGGER trg_tasks_search
        BEFORE INSERT OR UPDATE ON tasks
        FOR EACH ROW EXECUTE FUNCTION tasks_search_update();
    `);

    // cases
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION cases_search_update() RETURNS TRIGGER AS $$
      BEGIN
        NEW.search_vector :=
          setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B');
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_cases_search ON cases;
      CREATE TRIGGER trg_cases_search
        BEFORE INSERT OR UPDATE ON cases
        FOR EACH ROW EXECUTE FUNCTION cases_search_update();
    `);

    // =========================================================================
    // 4. SUPABASE RLS POLICIES — tenant + row-level isolation
    // =========================================================================

    // Enable RLS on tenant-scoped tables
    const rlsTables = [
      'tenants', 'users', 'roles', 'sessions', 'api_keys',
      'universal_entities', 'cases', 'notes', 'entity_tags', 'tags',
      'documents', 'document_versions', 'document_metadata',
      'workflows', 'workflow_states', 'workflow_transitions', 'workflow_instances',
      'form_schemas', 'form_fields', 'form_submissions',
      'tasks', 'task_comments', 'recurring_jobs',
      'subscriptions', 'invoices', 'invoice_items', 'usage_records', 'credit_ledger',
      'reports', 'report_executions', 'dashboard_widgets',
      'notifications', 'notification_preferences', 'notification_templates',
      'config_packs', 'config_versions', 'feature_flags', 'tenant_config_pins',
      'integration_instances', 'storage_files', 'file_versions',
      'queue_jobs', 'queue_job_logs',
      'search_keywords',
    ];

    for (const table of rlsTables) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation_${table}'
          ) THEN
            CREATE POLICY tenant_isolation_${table} ON ${table}
              FOR ALL
              USING (tenant_id = current_setting('meru.current_tenant_id', true)::UUID)
              WITH CHECK (tenant_id = current_setting('meru.current_tenant_id', true)::UUID);
          END IF;
        END $$;
      `);
    }

    // Special policies for users (self-access)
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'users_self_access') THEN
          CREATE POLICY users_self_access ON users
            FOR SELECT
            USING (
              id = current_setting('meru.current_user_id', true)::UUID
              OR tenant_id = current_setting('meru.current_tenant_id', true)::UUID
            );
        END IF;
      END $$;
    `);

    // Special policies for sessions (self-access only)
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'sessions_self_access') THEN
          CREATE POLICY sessions_self_access ON sessions
            FOR ALL
            USING (user_id = current_setting('meru.current_user_id', true)::UUID);
        END IF;
      END $$;
    `);

    // Notifications policy (user-scoped)
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'notifications_user_scope') THEN
          CREATE POLICY notifications_user_scope ON notifications
            FOR ALL
            USING (
              user_id = current_setting('meru.current_user_id', true)::UUID
              AND tenant_id = current_setting('meru.current_tenant_id', true)::UUID
            );
        END IF;
      END $$;
    `);

    // =========================================================================
    // 5. RLS HELPER: SET configuration for multi-tenant context
    // =========================================================================
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION set_meru_context(p_tenant_id UUID, p_user_id UUID DEFAULT NULL, p_request_id TEXT DEFAULT NULL)
      RETURNS VOID AS $$
      BEGIN
        PERFORM set_config('meru.current_tenant_id', p_tenant_id::TEXT, false);
        IF p_user_id IS NOT NULL THEN
          PERFORM set_config('meru.current_user_id', p_user_id::TEXT, false);
        END IF;
        IF p_request_id IS NOT NULL THEN
          PERFORM set_config('meru.request_id', p_request_id, false);
        END IF;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION clear_meru_context()
      RETURNS VOID AS $$
      BEGIN
        PERFORM set_config('meru.current_tenant_id', '', false);
        PERFORM set_config('meru.current_user_id', '', false);
        PERFORM set_config('meru.request_id', '', false);
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop RLS policies
    const rlsTables = [
      'tenants', 'users', 'roles', 'sessions', 'api_keys',
      'universal_entities', 'cases', 'notes', 'entity_tags', 'tags',
      'documents', 'document_versions', 'document_metadata',
      'workflows', 'workflow_states', 'workflow_transitions', 'workflow_instances',
      'form_schemas', 'form_fields', 'form_submissions',
      'tasks', 'task_comments', 'recurring_jobs',
      'subscriptions', 'invoices', 'invoice_items', 'usage_records', 'credit_ledger',
      'reports', 'report_executions', 'dashboard_widgets',
      'notifications', 'notification_preferences', 'notification_templates',
      'config_packs', 'config_versions', 'feature_flags', 'tenant_config_pins',
      'integration_instances', 'storage_files', 'file_versions',
      'queue_jobs', 'queue_job_logs',
      'search_keywords',
    ];

    for (const table of rlsTables) {
      await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation_${table} ON ${table};`);
      await queryRunner.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`);
    }

    // Drop triggers
    const auditTables = [
      'tenants', 'users', 'roles', 'sessions', 'api_keys',
      'universal_entities', 'cases', 'notes',
      'documents', 'document_versions',
      'tasks', 'task_comments',
      'workflows', 'workflow_instances',
      'form_schemas', 'form_submissions',
      'subscriptions', 'invoices',
      'reports', 'notification_templates',
      'config_packs', 'feature_flags',
      'integration_instances',
    ];

    for (const table of auditTables) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS trg_audit_${table} ON ${table};`);
    }

    await queryRunner.query(`DROP FUNCTION IF EXISTS audit_trigger_function() CASCADE;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS set_meru_context(UUID, UUID, TEXT) CASCADE;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS clear_meru_context() CASCADE;`);

    // Drop search triggers
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_universal_entities_search ON universal_entities;`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_documents_search ON documents;`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_tasks_search ON tasks;`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_cases_search ON cases;`);

    await queryRunner.query(`DROP FUNCTION IF EXISTS universal_entities_search_update() CASCADE;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS documents_search_update() CASCADE;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS tasks_search_update() CASCADE;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS cases_search_update() CASCADE;`);
  }
}