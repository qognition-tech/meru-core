import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `audit_logs.beforeState` / `afterState` must be nullable.
 *
 * The entity has always typed these as `Record<string, any> | null`, but the
 * `@Column({ type: 'jsonb' })` decorator carried no `nullable: true`, so the
 * columns were created NOT NULL. Any audit event without both states — every
 * READ, LOGIN, LOGOUT and EXPORT — therefore failed its insert with
 * `null value in column "beforeState" violates not-null constraint`.
 *
 * That silently disabled a chunk of CLAUDE.md §6.5 ("audit everything") and,
 * more sharply, broke `TenancyService.runAsGod`: it writes a CRITICAL audit
 * entry *before* running the cross-tenant work and rethrows if the write fails,
 * so every God-View request 500'd. Verified by `GET /tenants` returning that
 * exact constraint error.
 */
export class FixAuditLogNullableState1753600000000 implements MigrationInterface {
  name = 'FixAuditLogNullableState1753600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ALTER COLUMN "beforeState" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ALTER COLUMN "afterState" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restoring NOT NULL requires backfilling the rows this fix allows to
    // exist, or the constraint cannot be re-added.
    await queryRunner.query(
      `UPDATE "audit_logs" SET "beforeState" = '{}'::jsonb WHERE "beforeState" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "audit_logs" SET "afterState" = '{}'::jsonb WHERE "afterState" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ALTER COLUMN "beforeState" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ALTER COLUMN "afterState" SET NOT NULL`,
    );
  }
}
