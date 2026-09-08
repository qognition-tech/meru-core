import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-tenant regulator connector registry (MASTER_GAP_ANALYSIS §2 P1 item 9):
 * which adapters a tenant has enabled, sandbox/live, and their encrypted
 * credentials. Standard tenant_isolation RLS — a tenant's connector rows and
 * credentials are theirs alone.
 */
export class AddTenantConnectors1754700000000 implements MigrationInterface {
  name = 'AddTenantConnectors1754700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "tenant_connectors_mode_enum" AS ENUM('sandbox', 'live');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tenant_connectors" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "adapterCode" character varying(100) NOT NULL,
        "enabled" boolean NOT NULL DEFAULT false,
        "mode" "tenant_connectors_mode_enum" NOT NULL DEFAULT 'sandbox',
        "credentials" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tenant_connectors_tenant" ON "tenant_connectors" ("tenantId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_tenant_connectors_tenant_adapter" ON "tenant_connectors" ("tenantId", "adapterCode")`,
    );

    await queryRunner.query(
      `ALTER TABLE "tenant_connectors" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_connectors" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "tenant_connectors"`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "tenant_connectors" FOR ALL TO public
        USING (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
        WITH CHECK (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "tenant_connectors"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "tenant_connectors_mode_enum"`,
    );
  }
}
