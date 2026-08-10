import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Where a payment came from, on the row rather than in a jsonb blob.
 *
 * `payments` had one undifferentiated `amountMinor`, so a government charge
 * collected at cost on the regulator's behalf was indistinguishable from the
 * firm's own revenue. That is not a reporting nicety: a firm that counts
 * passed-through visa fees as income overstates its revenue, and a
 * non-refundable government charge and a refundable firm fee behave
 * differently the moment a client withdraws.
 *
 * Columns, not metadata, because every one of these is something you filter or
 * group by — "government fees collected this quarter", "what is unpaid at the
 * lodgement step" — and a jsonb predicate cannot use an index the way a column
 * can.
 *
 * All nullable and additive: every existing payment row keeps working, and a
 * payment created by hand rather than expanded from a pack simply has no fee
 * provenance.
 */
export class AddPaymentFeeProvenance1755600000000 implements MigrationInterface {
  name = 'AddPaymentFeeProvenance1755600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD COLUMN IF NOT EXISTS "feeKind" character varying(20),
        ADD COLUMN IF NOT EXISTS "feeKey" character varying(100),
        ADD COLUMN IF NOT EXISTS "planKey" character varying(100),
        ADD COLUMN IF NOT EXISTS "atStep" character varying(100)
    `);

    // The payment gate's query: "is anything unpaid at this step for this
    // case?" runs on every workflow transition, so it gets an index.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payments_entity_step" ON "payments" ("tenantId","entityId","atStep")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payments_tenant_fee_kind" ON "payments" ("tenantId","feeKind")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_payments_tenant_fee_kind"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payments_entity_step"`);
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP COLUMN IF EXISTS "atStep",
        DROP COLUMN IF EXISTS "planKey",
        DROP COLUMN IF EXISTS "feeKey",
        DROP COLUMN IF EXISTS "feeKind"
    `);
  }
}
