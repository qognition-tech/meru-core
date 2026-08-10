import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `alert_firings` — the memory behind pack-driven alert rules.
 *
 * The sweep re-evaluates every rule against every entity on every pass, so a
 * condition that stays true (a visa expiring inside 30 days is true on all
 * thirty) would notify on every pass without this table. That is not a cosmetic
 * problem: it trains recipients to filter the sender, and the alert that
 * mattered goes with the rest.
 *
 * Tenant-scoped — an alert is one firm's operational state and must never be
 * visible to another. Ordinary tenant_isolation with ENABLE + FORCE, per
 * CLAUDE.md §6.4.
 *
 * The unique index on (tenantId, ruleKey, entityId) is doing real work: the
 * sweep upserts on it, so two overlapping passes (a manual run during a cron
 * run) cannot produce two firing records for one condition and notify twice.
 */
export class AddAlertFirings1755400000000 implements MigrationInterface {
  name = 'AddAlertFirings1755400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "alert_firings" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "ruleKey" character varying(100) NOT NULL,
        "entityId" uuid NOT NULL,
        "entityType" character varying(50) NOT NULL,
        "firstMatchedAt" TIMESTAMPTZ NOT NULL,
        "lastMatchedAt" TIMESTAMPTZ NOT NULL,
        "lastNotifiedAt" TIMESTAMPTZ,
        "notifyCount" integer NOT NULL DEFAULT 0,
        "escalatedAt" TIMESTAMPTZ,
        "resolvedAt" TIMESTAMPTZ,
        "taskId" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_alert_firings_tenant" ON "alert_firings" ("tenantId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_alert_firings_rule_entity" ON "alert_firings" ("tenantId","ruleKey","entityId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_alert_firings_tenant_rule" ON "alert_firings" ("tenantId","ruleKey")`,
    );

    await queryRunner.query(
      `ALTER TABLE "alert_firings" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "alert_firings" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "alert_firings"`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "alert_firings" FOR ALL TO public
        USING (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
        WITH CHECK (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "alert_firings"`);
  }
}
