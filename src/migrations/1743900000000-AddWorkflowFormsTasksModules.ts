import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWorkflowFormsTasksModules1743900000000 implements MigrationInterface {
  name = 'AddWorkflowFormsTasksModules1743900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ==================== WORKFLOW TABLES ====================

    // Create workflows table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS workflows (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id VARCHAR(36) NOT NULL,
        vertical VARCHAR(50),
        environment VARCHAR(20),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        entity_type VARCHAR(50) NOT NULL,
        status VARCHAR(20) DEFAULT 'draft',
        trigger VARCHAR(20) DEFAULT 'manual',
        trigger_config JSONB DEFAULT '{}',
        version INTEGER DEFAULT 1,
        sla_config JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_workflows_tenant_status ON workflows(tenant_id, status)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_workflows_tenant_entity ON workflows(tenant_id, entity_type)
    `);

    // Create workflow_states table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS workflow_states (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        type VARCHAR(20) DEFAULT 'intermediate',
        config JSONB DEFAULT '{}'
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_workflow_states_workflow ON workflow_states(workflow_id, name)
    `);

    // Create workflow_transitions table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS workflow_transitions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        from_state_id UUID NOT NULL REFERENCES workflow_states(id),
        to_state_id UUID NOT NULL REFERENCES workflow_states(id),
        name VARCHAR(100) NOT NULL,
        description TEXT,
        type VARCHAR(20) DEFAULT 'manual',
        conditions JSONB DEFAULT '{"operator": "AND", "rules": []}',
        actions JSONB DEFAULT '[]',
        permissions JSONB DEFAULT '{}',
        is_active BOOLEAN DEFAULT true
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_workflow_transitions_workflow_from ON workflow_transitions(workflow_id, from_state_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_workflow_transitions_workflow_to ON workflow_transitions(workflow_id, to_state_id)
    `);

    // Create workflow_instances table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS workflow_instances (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id VARCHAR(36) NOT NULL,
        vertical VARCHAR(50),
        environment VARCHAR(20),
        workflow_id UUID NOT NULL REFERENCES workflows(id),
        entity_id VARCHAR(36) NOT NULL,
        entity_type VARCHAR(50) NOT NULL,
        current_state_id UUID NOT NULL REFERENCES workflow_states(id),
        status VARCHAR(20) DEFAULT 'active',
        context JSONB DEFAULT '{}',
        history JSONB DEFAULT '[]',
        state_entered_at TIMESTAMP,
        sla_deadline TIMESTAMP,
        escalation_level INTEGER DEFAULT 0,
        sla_violations JSONB DEFAULT '[]',
        started_by VARCHAR(36) NOT NULL,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_workflow_instances_tenant_status ON workflow_instances(tenant_id, status)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_workflow_instances_tenant_entity ON workflow_instances(tenant_id, entity_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_workflow_instances_workflow_status ON workflow_instances(workflow_id, status)
    `);

    // ==================== FORMS TABLES ====================

    // Create form_schemas table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS form_schemas (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id VARCHAR(36) NOT NULL,
        vertical VARCHAR(50),
        environment VARCHAR(20),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        entity_type VARCHAR(50) NOT NULL,
        status VARCHAR(20) DEFAULT 'draft',
        layout VARCHAR(20) DEFAULT 'single_column',
        version INTEGER DEFAULT 1,
        config JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_form_schemas_tenant_status ON form_schemas(tenant_id, status)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_form_schemas_tenant_entity ON form_schemas(tenant_id, entity_type)
    `);

    // Create form_fields table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS form_fields (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        form_schema_id UUID NOT NULL REFERENCES form_schemas(id) ON DELETE CASCADE,
        key VARCHAR(100) NOT NULL,
        label VARCHAR(255) NOT NULL,
        description TEXT,
        placeholder TEXT,
        type VARCHAR(50) NOT NULL,
        order_index INTEGER DEFAULT 0,
        validation JSONB DEFAULT '{}',
        options JSONB DEFAULT '{}',
        config JSONB DEFAULT '{}',
        conditional_logic JSONB
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_form_fields_schema ON form_fields(form_schema_id, key)
    `);

    // Create form_submissions table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS form_submissions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id VARCHAR(36) NOT NULL,
        vertical VARCHAR(50),
        environment VARCHAR(20),
        form_schema_id UUID NOT NULL REFERENCES form_schemas(id),
        entity_id VARCHAR(36),
        status VARCHAR(20) DEFAULT 'draft',
        data JSONB NOT NULL,
        history JSONB DEFAULT '[]',
        validation_errors JSONB DEFAULT '[]',
        metadata JSONB DEFAULT '{}',
        submitted_by VARCHAR(36) NOT NULL,
        submitted_at TIMESTAMP,
        reviewed_by VARCHAR(36),
        reviewed_at TIMESTAMP,
        review_notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_form_submissions_tenant_status ON form_submissions(tenant_id, status)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_form_submissions_tenant_entity ON form_submissions(tenant_id, entity_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_form_submissions_schema_status ON form_submissions(form_schema_id, status)
    `);

    // ==================== TASKS TABLES ====================

    // Create tasks table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id VARCHAR(36) NOT NULL,
        vertical VARCHAR(50),
        environment VARCHAR(20),
        title VARCHAR(255) NOT NULL,
        description TEXT,
        type VARCHAR(20) DEFAULT 'action',
        status VARCHAR(20) DEFAULT 'todo',
        priority VARCHAR(20) DEFAULT 'medium',
        assigned_to VARCHAR(36) NOT NULL,
        assigned_by VARCHAR(36),
        due_date TIMESTAMP,
        reminder_date TIMESTAMP,
        entity_id VARCHAR(36),
        entity_type VARCHAR(50),
        workflow_instance_id VARCHAR(36),
        config JSONB DEFAULT '{}',
        attachments JSONB DEFAULT '[]',
        metadata JSONB DEFAULT '{}',
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        completed_by VARCHAR(36),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status ON tasks(tenant_id, status)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_tenant_assigned ON tasks(tenant_id, assigned_to)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_tenant_due ON tasks(tenant_id, due_date)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_entity ON tasks(entity_id, entity_type)
    `);

    // Create task_comments table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS task_comments (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id VARCHAR(36) NOT NULL,
        content TEXT NOT NULL,
        mentions JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create recurring_jobs table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS recurring_jobs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id VARCHAR(36) NOT NULL,
        vertical VARCHAR(50),
        environment VARCHAR(20),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        schedule VARCHAR(100) NOT NULL,
        task_template JSONB NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        last_run_at TIMESTAMP,
        next_run_at TIMESTAMP,
        run_count INTEGER DEFAULT 0,
        start_date TIMESTAMP,
        end_date TIMESTAMP,
        run_history JSONB DEFAULT '[]',
        config JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_recurring_jobs_tenant_status ON recurring_jobs(tenant_id, status)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_recurring_jobs_next_run ON recurring_jobs(next_run_at) WHERE status = 'active'
    `);

    // Enable RLS on new tables
    await queryRunner.query(`
      ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
      ALTER TABLE workflow_states ENABLE ROW LEVEL SECURITY;
      ALTER TABLE workflow_transitions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE workflow_instances ENABLE ROW LEVEL SECURITY;
      ALTER TABLE form_schemas ENABLE ROW LEVEL SECURITY;
      ALTER TABLE form_fields ENABLE ROW LEVEL SECURITY;
      ALTER TABLE form_submissions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
      ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;
      ALTER TABLE recurring_jobs ENABLE ROW LEVEL SECURITY;
    `);

    // Create RLS policies for new tables
    await queryRunner.query(`
      CREATE POLICY vertical_env_isolation_workflows ON workflows
        FOR ALL USING (app.has_access(vertical, environment));

      CREATE POLICY vertical_env_isolation_workflow_states ON workflow_states
        FOR ALL USING (
          EXISTS (
            SELECT 1 FROM workflows w
            WHERE w.id = workflow_states.workflow_id
            AND app.has_access(w.vertical, w.environment)
          )
        );

      CREATE POLICY vertical_env_isolation_workflow_transitions ON workflow_transitions
        FOR ALL USING (
          EXISTS (
            SELECT 1 FROM workflows w
            WHERE w.id = workflow_transitions.workflow_id
            AND app.has_access(w.vertical, w.environment)
          )
        );

      CREATE POLICY vertical_env_isolation_workflow_instances ON workflow_instances
        FOR ALL USING (app.has_access(vertical, environment));

      CREATE POLICY vertical_env_isolation_form_schemas ON form_schemas
        FOR ALL USING (app.has_access(vertical, environment));

      CREATE POLICY vertical_env_isolation_form_fields ON form_fields
        FOR ALL USING (
          EXISTS (
            SELECT 1 FROM form_schemas f
            WHERE f.id = form_fields.form_schema_id
            AND app.has_access(f.vertical, f.environment)
          )
        );

      CREATE POLICY vertical_env_isolation_form_submissions ON form_submissions
        FOR ALL USING (app.has_access(vertical, environment));

      CREATE POLICY vertical_env_isolation_tasks ON tasks
        FOR ALL USING (app.has_access(vertical, environment));

      CREATE POLICY vertical_env_isolation_task_comments ON task_comments
        FOR ALL USING (
          EXISTS (
            SELECT 1 FROM tasks t
            WHERE t.id = task_comments.task_id
            AND app.has_access(t.vertical, t.environment)
          )
        );

      CREATE POLICY vertical_env_isolation_recurring_jobs ON recurring_jobs
        FOR ALL USING (app.has_access(vertical, environment));
    `);

    // Create triggers for vertical/environment fields
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS set_context_fields_workflows ON workflows;
      CREATE TRIGGER set_context_fields_workflows BEFORE INSERT OR UPDATE ON workflows
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_workflow_instances ON workflow_instances;
      CREATE TRIGGER set_context_fields_workflow_instances BEFORE INSERT OR UPDATE ON workflow_instances
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_form_schemas ON form_schemas;
      CREATE TRIGGER set_context_fields_form_schemas BEFORE INSERT OR UPDATE ON form_schemas
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_form_submissions ON form_submissions;
      CREATE TRIGGER set_context_fields_form_submissions BEFORE INSERT OR UPDATE ON form_submissions
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_tasks ON tasks;
      CREATE TRIGGER set_context_fields_tasks BEFORE INSERT OR UPDATE ON tasks
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_recurring_jobs ON recurring_jobs;
      CREATE TRIGGER set_context_fields_recurring_jobs BEFORE INSERT OR UPDATE ON recurring_jobs
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop triggers
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS set_context_fields_workflows ON workflows;
      DROP TRIGGER IF EXISTS set_context_fields_workflow_instances ON workflow_instances;
      DROP TRIGGER IF EXISTS set_context_fields_form_schemas ON form_schemas;
      DROP TRIGGER IF EXISTS set_context_fields_form_submissions ON form_submissions;
      DROP TRIGGER IF EXISTS set_context_fields_tasks ON tasks;
      DROP TRIGGER IF EXISTS set_context_fields_recurring_jobs ON recurring_jobs;
    `);

    // Drop RLS policies
    await queryRunner.query(`
      DROP POLICY IF EXISTS vertical_env_isolation_workflows ON workflows;
      DROP POLICY IF EXISTS vertical_env_isolation_workflow_states ON workflow_states;
      DROP POLICY IF EXISTS vertical_env_isolation_workflow_transitions ON workflow_transitions;
      DROP POLICY IF EXISTS vertical_env_isolation_workflow_instances ON workflow_instances;
      DROP POLICY IF EXISTS vertical_env_isolation_form_schemas ON form_schemas;
      DROP POLICY IF EXISTS vertical_env_isolation_form_fields ON form_fields;
      DROP POLICY IF EXISTS vertical_env_isolation_form_submissions ON form_submissions;
      DROP POLICY IF EXISTS vertical_env_isolation_tasks ON tasks;
      DROP POLICY IF EXISTS vertical_env_isolation_task_comments ON task_comments;
      DROP POLICY IF EXISTS vertical_env_isolation_recurring_jobs ON recurring_jobs;
    `);

    // Disable RLS
    await queryRunner.query(`
      ALTER TABLE workflows DISABLE ROW LEVEL SECURITY;
      ALTER TABLE workflow_states DISABLE ROW LEVEL SECURITY;
      ALTER TABLE workflow_transitions DISABLE ROW LEVEL SECURITY;
      ALTER TABLE workflow_instances DISABLE ROW LEVEL SECURITY;
      ALTER TABLE form_schemas DISABLE ROW LEVEL SECURITY;
      ALTER TABLE form_fields DISABLE ROW LEVEL SECURITY;
      ALTER TABLE form_submissions DISABLE ROW LEVEL SECURITY;
      ALTER TABLE tasks DISABLE ROW LEVEL SECURITY;
      ALTER TABLE task_comments DISABLE ROW LEVEL SECURITY;
      ALTER TABLE recurring_jobs DISABLE ROW LEVEL SECURITY;
    `);

    // Drop tables
    await queryRunner.query(`DROP TABLE IF EXISTS recurring_jobs CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS task_comments CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS tasks CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS form_submissions CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS form_fields CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS form_schemas CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS workflow_instances CASCADE`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS workflow_transitions CASCADE`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS workflow_states CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS workflows CASCADE`);
  }
}
