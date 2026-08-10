import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `sequence_enrolments` — progress state for pack-driven messaging sequences.
 *
 * Without it a sequence is a mailing loop: each sweep re-sends step 1 to every
 * record that still matches the trigger. The unique index on
 * (tenantId, sequenceKey, entityId) is the upsert key and the guard against
 * two overlapping sweeps enrolling one client twice.
 *
 * Tenant-scoped: who a firm is chasing, and how far through the chase they
 * are, is that firm's business. ENABLE + FORCE per CLAUDE.md §6.4.
 */
export class AddSequenceEnrolments1755500000000 implements MigrationInterface {
  name = 'AddSequenceEnrolments1755500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sequence_enrolments" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "sequenceKey" character varying(100) NOT NULL,
        "entityId" uuid NOT NULL,
        "entityType" character varying(50) NOT NULL,
        "enrolledAt" TIMESTAMPTZ NOT NULL,
        "stepsSent" integer NOT NULL DEFAULT 0,
        "lastSentAt" TIMESTAMPTZ,
        "stoppedAt" TIMESTAMPTZ,
        "stopReason" character varying(40),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_sequence_enrolments_tenant" ON "sequence_enrolments" ("tenantId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_sequence_enrolments_seq_entity" ON "sequence_enrolments" ("tenantId","sequenceKey","entityId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_sequence_enrolments_active" ON "sequence_enrolments" ("tenantId","stoppedAt")`,
    );

    await queryRunner.query(
      `ALTER TABLE "sequence_enrolments" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "sequence_enrolments" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "sequence_enrolments"`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "sequence_enrolments" FOR ALL TO public
        USING (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
        WITH CHECK (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sequence_enrolments"`);
  }
}
