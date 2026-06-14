import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVerticalAndEnvironmentRLS1743870000000 implements MigrationInterface {
  name = 'AddVerticalAndEnvironmentRLS1743870000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop existing RLS policies if they exist
    await queryRunner.query(`
      DROP POLICY IF EXISTS tenant_isolation_users ON users;
      DROP POLICY IF EXISTS tenant_isolation_tenants ON tenants;
      DROP POLICY IF EXISTS tenant_isolation_entities ON universal_entities;
      DROP POLICY IF EXISTS tenant_isolation_documents ON documents;
      DROP POLICY IF EXISTS tenant_isolation_doc_versions ON document_versions;
      DROP POLICY IF EXISTS tenant_isolation_doc_metadata ON document_metadata;
      DROP POLICY IF EXISTS tenant_isolation_ai_prompts ON ai_prompts;
      DROP POLICY IF EXISTS tenant_isolation_ai_embeddings ON ai_embeddings;
      DROP POLICY IF EXISTS tenant_isolation_search_indexes ON search_indexes;
      DROP POLICY IF EXISTS tenant_isolation_tenant_settings ON tenant_settings;
    `);

    // Add vertical and environment columns to all tenant-aware tables
    await queryRunner.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS vertical VARCHAR(50);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS environment VARCHAR(20);

      ALTER TABLE universal_entities ADD COLUMN IF NOT EXISTS vertical VARCHAR(50);
      ALTER TABLE universal_entities ADD COLUMN IF NOT EXISTS environment VARCHAR(20);

      ALTER TABLE documents ADD COLUMN IF NOT EXISTS vertical VARCHAR(50);
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS environment VARCHAR(20);

      ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS vertical VARCHAR(50);
      ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS environment VARCHAR(20);

      ALTER TABLE document_metadata ADD COLUMN IF NOT EXISTS vertical VARCHAR(50);
      ALTER TABLE document_metadata ADD COLUMN IF NOT EXISTS environment VARCHAR(20);

      ALTER TABLE ai_prompts ADD COLUMN IF NOT EXISTS vertical VARCHAR(50);
      ALTER TABLE ai_prompts ADD COLUMN IF NOT EXISTS environment VARCHAR(20);

      ALTER TABLE ai_embeddings ADD COLUMN IF NOT EXISTS vertical VARCHAR(50);
      ALTER TABLE ai_embeddings ADD COLUMN IF NOT EXISTS environment VARCHAR(20);

      ALTER TABLE search_indexes ADD COLUMN IF NOT EXISTS vertical VARCHAR(50);
      ALTER TABLE search_indexes ADD COLUMN IF NOT EXISTS environment VARCHAR(20);

      ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS vertical VARCHAR(50);
      ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS environment VARCHAR(20);
    `);

    // Create indexes for performance
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_users_vertical_env ON users(vertical, environment);
      CREATE INDEX IF NOT EXISTS idx_entities_vertical_env ON universal_entities(vertical, environment);
      CREATE INDEX IF NOT EXISTS idx_documents_vertical_env ON documents(vertical, environment);
      CREATE INDEX IF NOT EXISTS idx_ai_prompts_vertical_env ON ai_prompts(vertical, environment);
      CREATE INDEX IF NOT EXISTS idx_ai_embeddings_vertical_env ON ai_embeddings(vertical, environment);
      CREATE INDEX IF NOT EXISTS idx_search_vertical_env ON search_indexes(vertical, environment);
    `);

    // Create new RLS function for vertical + environment context
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app.set_context(vertical VARCHAR, environment VARCHAR)
      RETURNS void AS $$
      BEGIN
        PERFORM set_config('app.current_vertical', vertical);
        PERFORM set_config('app.current_environment', environment);
        PERFORM set_config('app.is_superuser', 'false');
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `);

    // Create function to check if current user has access
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app.has_access(lookup_vertical VARCHAR, lookup_environment VARCHAR)
      RETURNS boolean AS $$
      BEGIN
        RETURN (
          current_setting('app.current_vertical', '') IS NULL OR
          current_setting('app.current_environment', '') IS NULL OR
          current_setting('app.is_superuser', 'false')::boolean = true OR
          (
            current_setting('app.current_vertical', '') = lookup_vertical AND
            current_setting('app.current_environment', '') = lookup_environment
          ) OR
          (
            current_setting('app.current_vertical', '') = lookup_vertical AND
            current_setting('app.current_environment', '') IS NULL
          )
        );
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `);

    // Update trigger function to auto-set vertical and environment
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app.set_context_fields()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.vertical IS NULL AND TG_TABLE_NAME != 'tenants' THEN
          NEW.vertical := current_setting('app.current_vertical');
        END IF;

        IF NEW.environment IS NULL AND TG_TABLE_NAME != 'tenants' THEN
          NEW.environment := current_setting('app.current_environment');
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Create triggers for all tables
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS set_context_fields_users ON users;
      CREATE TRIGGER set_context_fields_users BEFORE INSERT OR UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_entities ON universal_entities;
      CREATE TRIGGER set_context_fields_entities BEFORE INSERT OR UPDATE ON universal_entities
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_documents ON documents;
      CREATE TRIGGER set_context_fields_documents BEFORE INSERT OR UPDATE ON documents
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_doc_versions ON document_versions;
      CREATE TRIGGER set_context_fields_doc_versions BEFORE INSERT OR UPDATE ON document_versions
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_doc_metadata ON document_metadata;
      CREATE TRIGGER set_context_fields_doc_metadata BEFORE INSERT OR UPDATE ON document_metadata
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_ai_prompts ON ai_prompts;
      CREATE TRIGGER set_context_fields_ai_prompts BEFORE INSERT OR UPDATE ON ai_prompts
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_ai_embeddings ON ai_embeddings;
      CREATE TRIGGER set_context_fields_ai_embeddings BEFORE INSERT OR UPDATE ON ai_embeddings
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_search_indexes ON search_indexes;
      CREATE TRIGGER set_context_fields_search_indexes BEFORE INSERT OR UPDATE ON search_indexes
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_tenant_settings ON tenant_settings;
      CREATE TRIGGER set_context_fields_tenant_settings BEFORE INSERT OR UPDATE ON tenant_settings
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();
    `);

    // Create RLS policies for vertical + environment isolation
    await queryRunner.query(`
      -- Users table policy
      CREATE POLICY vertical_env_isolation_users ON users
        FOR ALL
        USING (
          app.has_access(vertical, environment) OR
          current_setting('app.is_superuser')::boolean = true
        );

      -- Tenants table policy (superadmin can see all)
      CREATE POLICY vertical_env_isolation_tenants ON tenants
        FOR ALL
        USING (
          app.has_access(vertical, environment) OR
          current_setting('app.is_superuser')::boolean = true
        );

      -- Universal Entities policy
      CREATE POLICY vertical_env_isolation_entities ON universal_entities
        FOR ALL
        USING (
          app.has_access(vertical, environment)
        );

      -- Documents policy
      CREATE POLICY vertical_env_isolation_documents ON documents
        FOR ALL
        USING (
          app.has_access(vertical, environment)
        );

      -- Document Versions policy (check parent document's vertical/env)
      CREATE POLICY vertical_env_isolation_doc_versions ON document_versions
        FOR ALL
        USING (
          EXISTS (
            SELECT 1 FROM documents d
            WHERE d.id = document_versions.document_id
            AND app.has_access(d.vertical, d.environment)
          )
        );

      -- Document Metadata policy
      CREATE POLICY vertical_env_isolation_doc_metadata ON document_metadata
        FOR ALL
        USING (
          EXISTS (
            SELECT 1 FROM documents d
            WHERE d.id = document_metadata.document_id
            AND app.has_access(d.vertical, d.environment)
          )
        );

      -- AI Prompts policy (global or vertical-specific)
      CREATE POLICY vertical_env_isolation_ai_prompts ON ai_prompts
        FOR ALL
        USING (
          vertical IS NULL OR
          app.has_access(vertical, environment)
        );

      -- AI Embeddings policy
      CREATE POLICY vertical_env_isolation_ai_embeddings ON ai_embeddings
        FOR ALL
        USING (
          app.has_access(vertical, environment)
        );

      -- Search Indexes policy
      CREATE POLICY vertical_env_isolation_search_indexes ON search_indexes
        FOR ALL
        USING (
          app.has_access(vertical, environment)
        );

      -- Tenant Settings policy
      CREATE POLICY vertical_env_isolation_tenant_settings ON tenant_settings
        FOR ALL
        USING (
          app.has_access(vertical, environment)
        );
    `);

    // Grant execute permissions
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION app.set_context TO postgres;
      GRANT EXECUTE ON FUNCTION app.has_access TO postgres;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop triggers
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS set_context_fields_users ON users;
      DROP TRIGGER IF EXISTS set_context_fields_entities ON universal_entities;
      DROP TRIGGER IF EXISTS set_context_fields_documents ON documents;
      DROP TRIGGER IF EXISTS set_context_fields_doc_versions ON document_versions;
      DROP TRIGGER IF EXISTS set_context_fields_doc_metadata ON document_metadata;
      DROP TRIGGER IF EXISTS set_context_fields_ai_prompts ON ai_prompts;
      DROP TRIGGER IF EXISTS set_context_fields_ai_embeddings ON ai_embeddings;
      DROP TRIGGER IF EXISTS set_context_fields_search_indexes ON search_indexes;
      DROP TRIGGER IF EXISTS set_context_fields_tenant_settings ON tenant_settings;
    `);

    // Drop RLS policies
    await queryRunner.query(`
      DROP POLICY IF EXISTS vertical_env_isolation_users ON users;
      DROP POLICY IF EXISTS vertical_env_isolation_tenants ON tenants;
      DROP POLICY IF EXISTS vertical_env_isolation_entities ON universal_entities;
      DROP POLICY IF EXISTS vertical_env_isolation_documents ON documents;
      DROP POLICY IF EXISTS vertical_env_isolation_doc_versions ON document_versions;
      DROP POLICY IF EXISTS vertical_env_isolation_doc_metadata ON document_metadata;
      DROP POLICY IF EXISTS vertical_env_isolation_ai_prompts ON ai_prompts;
      DROP POLICY IF EXISTS vertical_env_isolation_ai_embeddings ON ai_embeddings;
      DROP POLICY IF EXISTS vertical_env_isolation_search_indexes ON search_indexes;
      DROP POLICY IF EXISTS vertical_env_isolation_tenant_settings ON tenant_settings;
    `);

    // Drop functions
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS app.set_context_fields CASCADE;
      DROP FUNCTION IF EXISTS app.set_context CASCADE;
      DROP FUNCTION IF EXISTS app.has_access CASCADE;
    `);

    // Drop columns
    await queryRunner.query(`
      ALTER TABLE users DROP COLUMN IF EXISTS vertical;
      ALTER TABLE users DROP COLUMN IF EXISTS environment;

      ALTER TABLE universal_entities DROP COLUMN IF EXISTS vertical;
      ALTER TABLE universal_entities DROP COLUMN IF EXISTS environment;

      ALTER TABLE documents DROP COLUMN IF EXISTS vertical;
      ALTER TABLE documents DROP COLUMN IF EXISTS environment;

      ALTER TABLE document_versions DROP COLUMN IF EXISTS vertical;
      ALTER TABLE document_versions DROP COLUMN IF EXISTS environment;

      ALTER TABLE document_metadata DROP COLUMN IF EXISTS vertical;
      ALTER TABLE document_metadata DROP COLUMN IF EXISTS environment;

      ALTER TABLE ai_prompts DROP COLUMN IF EXISTS vertical;
      ALTER TABLE ai_prompts DROP COLUMN IF EXISTS environment;

      ALTER TABLE ai_embeddings DROP COLUMN IF EXISTS vertical;
      ALTER TABLE ai_embeddings DROP COLUMN IF EXISTS environment;

      ALTER TABLE search_indexes DROP COLUMN IF EXISTS vertical;
      ALTER TABLE search_indexes DROP COLUMN IF EXISTS environment;

      ALTER TABLE tenant_settings DROP COLUMN IF EXISTS vertical;
      ALTER TABLE tenant_settings DROP COLUMN IF EXISTS environment;
    `);

    // Drop indexes
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_users_vertical_env;
      DROP INDEX IF EXISTS idx_entities_vertical_env;
      DROP INDEX IF EXISTS idx_documents_vertical_env;
      DROP INDEX IF EXISTS idx_ai_prompts_vertical_env;
      DROP INDEX IF EXISTS idx_ai_embeddings_vertical_env;
      DROP INDEX IF EXISTS idx_search_vertical_env;
    `);
  }
}
