import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `screening_results` — the durable record of who was screened and what came
 * back, which the rescreen sweep reads to decide who needs checking again.
 *
 * Tenant-scoped: a screening is a firm's own due-diligence record, and one
 * firm must never see who another firm screened. Ordinary tenant_isolation
 * policy with ENABLE + FORCE.
 */
export class AddScreeningResults1755300000000 implements MigrationInterface {
  name = 'AddScreeningResults1755300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "screening_results" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "screeningId" character varying(60) NOT NULL,
        "entityId" uuid,
        "entityName" text NOT NULL,
        "entityType" character varying(30) NOT NULL,
        "status" character varying(30) NOT NULL,
        "riskScore" integer NOT NULL DEFAULT 0,
        "riskLevel" character varying(20) NOT NULL,
        "hitCount" integer NOT NULL DEFAULT 0,
        "hits" jsonb NOT NULL DEFAULT '[]',
        "request" jsonb NOT NULL DEFAULT '{}',
        "screenedAt" TIMESTAMPTZ NOT NULL,
        "watchlistSize" integer NOT NULL DEFAULT 0,
        "isRescreen" boolean NOT NULL DEFAULT false,
        "previousStatus" character varying(30),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_screening_tenant" ON "screening_results" ("tenantId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_screening_tenant_entity" ON "screening_results" ("tenantId","entityId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_screening_tenant_status" ON "screening_results" ("tenantId","status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_screening_tenant_screened_at" ON "screening_results" ("tenantId","screenedAt")`,
    );

    await queryRunner.query(
      `ALTER TABLE "screening_results" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "screening_results" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "screening_results"`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "screening_results" FOR ALL TO public
        USING (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
        WITH CHECK (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "screening_results"`);
  }
}
