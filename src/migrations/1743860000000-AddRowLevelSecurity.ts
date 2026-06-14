import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRowLevelSecurity1743860000000 implements MigrationInterface {
  name = 'AddRowLevelSecurity1743860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enable Row-Level Security
    await queryRunner.query(`
      ALTER TABLE users ENABLE ROW LEVEL SECURITY;
      ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
      ALTER TABLE universal_entities ENABLE ROW LEVEL SECURITY;
      ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
      ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE document_metadata ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ai_prompts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ai_embeddings ENABLE ROW LEVEL SECURITY;
      ALTER TABLE search_indexes ENABLE ROW LEVEL SECURITY;
      ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
    `);

    // Create tenant_id column if not exists (for tables that need it)
    await queryRunner.query(`
      ALTER TABLE ai_prompts ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(36);
      ALTER TABLE ai_embeddings ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(36);
      ALTER TABLE search_indexes ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(36);
      ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(36);
    `);

    // Create indexes on tenant_id for performance
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_prompts_tenant_id ON ai_prompts(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_ai_embeddings_tenant_id ON ai_embeddings(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_search_indexes_tenant_id ON search_indexes(tenant_id);
    `);

    // Create RLS policies for tenant isolation
    // Users can only see their own tenant's data
    await queryRunner.query(`
      -- Users table policy
      CREATE POLICY tenant_isolation_users ON users
        FOR ALL
        USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

      -- Tenants table policy (superadmin can see all)
      CREATE POLICY tenant_isolation_tenants ON tenants
        FOR ALL
        USING (id = current_setting('app.current_tenant_id')::uuid OR current_setting('app.is_superuser') = 'true');

      -- Universal Entities policy
      CREATE POLICY tenant_isolation_entities ON universal_entities
        FOR ALL
        USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

      -- Documents policy
      CREATE POLICY tenant_isolation_documents ON documents
        FOR ALL
        USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

      -- Document Versions policy
      CREATE POLICY tenant_isolation_doc_versions ON document_versions
        FOR ALL
        USING (
          EXISTS (
            SELECT 1 FROM documents d
            WHERE d.id = document_versions.document_id
            AND d.tenant_id = current_setting('app.current_tenant_id')::uuid
          )
        );

      -- Document Metadata policy
      CREATE POLICY tenant_isolation_doc_metadata ON document_metadata
        FOR ALL
        USING (
          EXISTS (
            SELECT 1 FROM documents d
            WHERE d.id = document_metadata.document_id
            AND d.tenant_id = current_setting('app.current_tenant_id')::uuid
          )
        );

      -- AI Prompts policy
      CREATE POLICY tenant_isolation_ai_prompts ON ai_prompts
        FOR ALL
        USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id')::uuid);

      -- AI Embeddings policy
      CREATE POLICY tenant_isolation_ai_embeddings ON ai_embeddings
        FOR ALL
        USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

      -- Search Indexes policy
      CREATE POLICY tenant_isolation_search_indexes ON search_indexes
        FOR ALL
        USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

      -- Tenant Settings policy
      CREATE POLICY tenant_isolation_tenant_settings ON tenant_settings
        FOR ALL
        USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
    `);

    // Create function to set tenant context
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app.set_tenant_context(tenant_id uuid)
      RETURNS void AS $$
      BEGIN
        PERFORM set_config('app.current_tenant_id', tenant_id::text, true);
        PERFORM set_config('app.is_superuser', 'false', true);
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `);

    // Create function to check superuser
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app.set_superuser(superuser boolean)
      RETURNS void AS $$
      BEGIN
        PERFORM set_config('app.is_superuser', superuser::text, true);
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `);

    // Create trigger function to automatically set tenant_id
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app.set_tenant_id()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.tenant_id IS NULL AND TG_TABLE_NAME != 'tenants' THEN
          NEW.tenant_id := current_setting('app.current_tenant_id')::uuid;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Create triggers for tables with tenant_id
    await queryRunner.query(`
      CREATE TRIGGER set_tenant_id_users BEFORE INSERT OR UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION app.set_tenant_id();

      CREATE TRIGGER set_tenant_id_entities BEFORE INSERT OR UPDATE ON universal_entities
        FOR EACH ROW EXECUTE FUNCTION app.set_tenant_id();

      CREATE TRIGGER set_tenant_id_ai_prompts BEFORE INSERT OR UPDATE ON ai_prompts
        FOR EACH ROW EXECUTE FUNCTION app.set_tenant_id();

      CREATE TRIGGER set_tenant_id_ai_embeddings BEFORE INSERT OR UPDATE ON ai_embeddings
        FOR EACH ROW EXECUTE FUNCTION app.set_tenant_id();

      CREATE TRIGGER set_tenant_id_search_indexes BEFORE INSERT OR UPDATE ON search_indexes
        FOR EACH ROW EXECUTE FUNCTION app.set_tenant_id();
    `);

    // Grant execute permissions to application user
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION app.set_tenant_context TO postgres;
      GRANT EXECUTE ON FUNCTION app.set_superuser TO postgres;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop triggers
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS set_tenant_id_users ON users;
      DROP TRIGGER IF EXISTS set_tenant_id_entities ON universal_entities;
      DROP TRIGGER IF EXISTS set_tenant_id_ai_prompts ON ai_prompts;
      DROP TRIGGER IF EXISTS set_tenant_id_ai_embeddings ON ai_embeddings;
      DROP TRIGGER IF EXISTS set_tenant_id_search_indexes ON search_indexes;
    `);

    // Drop functions
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS app.set_tenant_id CASCADE;
      DROP FUNCTION IF EXISTS app.set_tenant_context CASCADE;
      DROP FUNCTION IF EXISTS app.set_superuser CASCADE;
    `);

    // Drop RLS policies
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

    // Disable Row-Level Security
    await queryRunner.query(`
      ALTER TABLE users DISABLE ROW LEVEL SECURITY;
      ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
      ALTER TABLE universal_entities DISABLE ROW LEVEL SECURITY;
      ALTER TABLE documents DISABLE ROW LEVEL SECURITY;
      ALTER TABLE document_versions DISABLE ROW LEVEL SECURITY;
      ALTER TABLE document_metadata DISABLE ROW LEVEL SECURITY;
      ALTER TABLE ai_prompts DISABLE ROW LEVEL SECURITY;
      ALTER TABLE ai_embeddings DISABLE ROW LEVEL SECURITY;
      ALTER TABLE search_indexes DISABLE ROW LEVEL SECURITY;
      ALTER TABLE tenant_settings DISABLE ROW LEVEL SECURITY;
    `);

    // Remove tenant_id columns (cleanup)
    await queryRunner.query(`
      ALTER TABLE ai_prompts DROP COLUMN IF EXISTS tenant_id;
      ALTER TABLE ai_embeddings DROP COLUMN IF EXISTS tenant_id;
      ALTER TABLE search_indexes DROP COLUMN IF EXISTS tenant_id;
      ALTER TABLE tenant_settings DROP COLUMN IF EXISTS tenant_id;
    `);
  }
}
