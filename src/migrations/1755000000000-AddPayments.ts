import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `payments` — what a firm's clients owe the firm, distinct from BILL, which
 * is Meru charging the firm.
 *
 * Tenant-scoped, so it gets the ordinary `tenant_isolation` policy with
 * ENABLE **and** FORCE (without FORCE the table owner is exempt and the
 * policy is decorative). Intra-tenant scoping — one applicant not reading
 * another's ledger — is enforced in the service by `clientId`; RLS separates
 * tenants, never users inside one.
 */
export class AddPayments1755000000000 implements MigrationInterface {
  name = 'AddPayments1755000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "payments_status_enum" AS ENUM
          ('pending','paid','failed','refunded','cancelled');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "payments" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "clientId" uuid NOT NULL,
        "entityId" uuid,
        "amountMinor" bigint NOT NULL,
        "currency" character varying(3) NOT NULL,
        "status" "payments_status_enum" NOT NULL DEFAULT 'pending',
        "description" character varying(300) NOT NULL,
        "reference" character varying(60),
        "dueDate" TIMESTAMPTZ,
        "paidAt" TIMESTAMPTZ,
        "providerRef" character varying(255),
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_payments_amount_positive" CHECK ("amountMinor" > 0)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payments_tenant" ON "payments" ("tenantId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payments_tenant_client" ON "payments" ("tenantId", "clientId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payments_tenant_status" ON "payments" ("tenantId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payments_tenant_entity" ON "payments" ("tenantId", "entityId")`,
    );

    // Partial unique: Stripe delivers webhooks at least once, so a retry of
    // checkout.session.completed must not be able to mark a payment paid
    // twice. NULL is excluded because unpaid rows have no provider reference
    // and NULLs do not collide in a unique index anyway.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payments_provider_ref"
         ON "payments" ("providerRef") WHERE "providerRef" IS NOT NULL`,
    );

    await queryRunner.query(`ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "payments" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "payments"`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "payments" FOR ALL TO public
        USING (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
        WITH CHECK (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "payments"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payments_status_enum"`);
  }
}
