import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR 0009 §2.4 — a firm's own professional-fee amounts (`fees[].kind ===
 * 'firm'`) become a tenant-scoped override instead of a value shared by
 * every tenant of the vertical.
 *
 * `firm_professional_482` in `verticals/immigration.json` quotes AU$3,500 to
 * every ImmiStack tenant on the base pack, whether that firm actually charges
 * that or not — a live 80/20 violation (`meru-core/CLAUDE.md` §5.5), not a
 * hypothetical one. Government charges and third-party disbursements are not
 * affected: they stay pack-owned, and `FeeScheduleService` refuses to let a
 * write here name a `feeKey` that is not `kind: 'firm'` in the resolved pack.
 *
 * Standard tenant_isolation RLS, ENABLE + FORCE at creation — same shape as
 * `1754700000000-AddTenantConnectors.ts`, the direct precedent for a small
 * per-tenant settings table. Unique on `("tenantId", "feeKey")`: one row per
 * fee per tenant, so "which amount is live" is never ambiguous.
 */
export class AddTenantFeeOverrides1756700000000 implements MigrationInterface {
  name = 'AddTenantFeeOverrides1756700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tenant_fee_overrides" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "feeKey" character varying(100) NOT NULL,
        "amountMinor" bigint NOT NULL,
        "currency" character varying(3) NOT NULL,
        "active" boolean NOT NULL DEFAULT true,
        "updatedBy" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_tenant_fee_overrides_amount_positive" CHECK ("amountMinor" > 0)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tenant_fee_overrides_tenant" ON "tenant_fee_overrides" ("tenantId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_tenant_fee_overrides_tenant_fee" ON "tenant_fee_overrides" ("tenantId", "feeKey")`,
    );

    await queryRunner.query(
      `ALTER TABLE "tenant_fee_overrides" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_fee_overrides" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "tenant_fee_overrides"`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "tenant_fee_overrides" FOR ALL TO public
        USING (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
        WITH CHECK (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "tenant_fee_overrides"`);
  }
}
