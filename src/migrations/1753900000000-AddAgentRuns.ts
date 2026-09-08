import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Execution history for the autonomous agents.
 *
 * The agents themselves stay as code — the specialist engines of CLAUDE.md §3
 * and the scheduled services. A database registry of code that already exists
 * would drift the moment someone added an engine, so there is no `agents`
 * table. What genuinely cannot be derived from source is history: when an
 * agent last ran, whether it worked, how often it fails, and whether a person
 * or the scheduler set it off. That is this table, and it is what the
 * GovernanceX Agents page renders.
 *
 * `tenantId` means it is picked up automatically by the catalog-driven policy
 * loop in AddTenantRowLevelSecurity — one tenant cannot read another's runs.
 */
export class AddAgentRuns1753900000000 implements MigrationInterface {
  name = 'AddAgentRuns1753900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_runs_status_enum') THEN
          CREATE TYPE "agent_runs_status_enum" AS ENUM ('running', 'success', 'failed');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_runs" (
        "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"    VARCHAR NOT NULL,
        "agentId"     VARCHAR(64) NOT NULL,
        "status"      "agent_runs_status_enum" NOT NULL DEFAULT 'running',
        "startedAt"   TIMESTAMPTZ NOT NULL,
        "finishedAt"  TIMESTAMPTZ,
        "durationMs"  INTEGER,
        "message"     TEXT,
        "triggeredBy" UUID,
        "result"      JSONB NOT NULL DEFAULT '{}'::jsonb,
        "createdAt"   TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_agent_runs_tenant" ON "agent_runs" ("tenantId")`,
    );
    // The two real reads: "history for this agent" and "latest run per agent".
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_agent_runs_tenant_agent_started" ON "agent_runs" ("tenantId", "agentId", "startedAt" DESC)`,
    );

    // Tenant isolation, matching the pattern the RLS migration applies to every
    // other tenant-scoped table. Written explicitly because that migration has
    // already run — a new table does not get a policy retroactively, and
    // without one it would be readable across tenants (CLAUDE.md §6.4).
    await queryRunner.query(
      `ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_runs" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "agent_runs"`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "agent_runs" FOR ALL TO public
        USING (app.rls_bypassed() OR "tenantId" = app.current_tenant_id())
        WITH CHECK (app.rls_bypassed() OR "tenantId" = app.current_tenant_id())
    `);
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_runs" TO meru_app`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_runs"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "agent_runs_status_enum"`);
  }
}
