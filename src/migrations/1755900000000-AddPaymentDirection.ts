import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Money the firm pays *out*, which had nowhere to go.
 *
 * `payments` modelled one direction: what a client owes the firm. The firm
 * paying the Department's lodgement charge is the other half of the same step,
 * and there was no row type for it — the frontend recorded it as a file note,
 * because writing it as a payment would have inflated revenue by the amount of
 * every government fee the firm ever forwarded.
 *
 * `direction` rather than a second table. A disbursement has the same shape as a
 * receipt (amount, currency, status, due date, settlement date, matter, fee
 * provenance), the same lifecycle, and belongs in the same ledger — a matter's
 * financial history is one list, and splitting it across two tables would mean
 * every reader joining them back together.
 *
 * Defaulted to `inbound` and then set NOT NULL, so every existing row keeps its
 * meaning. A backfill that left nulls would make "is this revenue?" a
 * three-valued question, and the summary would have to guess.
 *
 * `clientId` becomes nullable in the same change: a payment to the Department
 * *for* a client names them, but a firm-level expense — an annual registration
 * fee, a software subscription passed through — has no client and must not be
 * forced to invent one.
 */
export class AddPaymentDirection1755900000000 implements MigrationInterface {
  name = 'AddPaymentDirection1755900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD COLUMN IF NOT EXISTS "direction" character varying(10),
        ADD COLUMN IF NOT EXISTS "payee" character varying(200)
    `);

    // Existing rows are all receivables — that is the only thing the table
    // could express before this migration.
    await queryRunner.query(
      `UPDATE "payments" SET "direction" = 'inbound' WHERE "direction" IS NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE "payments"
        ALTER COLUMN "direction" SET DEFAULT 'inbound',
        ALTER COLUMN "direction" SET NOT NULL
    `);

    // An outbound payment need not belong to a client.
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "clientId" DROP NOT NULL`,
    );

    // A disbursement without a payee is a payment to nobody. Enforced in the
    // database rather than only in a DTO: the ledger is the record of what the
    // firm spent, and "we paid $3,050 to (blank)" is not a record.
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD CONSTRAINT "CHK_payments_outbound_has_payee"
        CHECK ("direction" <> 'outbound' OR "payee" IS NOT NULL)
    `);

    // Every summary and ledger read filters on direction, so it never scans
    // receivables to total expenditure.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payments_tenant_direction" ON "payments" ("tenantId","direction")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_payments_tenant_direction"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "CHK_payments_outbound_has_payee"`,
    );
    // Outbound rows have no clientId, so they must go before the column can be
    // NOT NULL again. They are expenditure records the pre-migration schema
    // cannot represent at all.
    await queryRunner.query(
      `DELETE FROM "payments" WHERE "direction" = 'outbound'`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "clientId" SET NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP COLUMN IF EXISTS "payee",
        DROP COLUMN IF EXISTS "direction"
    `);
  }
}
