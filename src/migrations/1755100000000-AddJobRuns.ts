import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `job_runs` — last-run state per scheduled job.
 *
 * Platform-global, same shape as `watchlist_entries`: readable by any bound
 * tenant (the God UI reads it), writable only under the system bypass, so
 * only the cron entrypoint can author rows. A tenant that could write here
 * could convince the platform a sanctions ingest had run when it had not.
 */
export class AddJobRuns1755100000000 implements MigrationInterface {
  name = 'AddJobRuns1755100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "job_runs" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "jobName" character varying(60) NOT NULL,
        "lastRunAt" TIMESTAMPTZ NOT NULL,
        "lastStatus" character varying(20) NOT NULL,
        "lastDurationMs" integer NOT NULL DEFAULT 0,
        "lastError" text,
        "lastSuccessAt" TIMESTAMPTZ,
        "runCount" integer NOT NULL DEFAULT 0,
        "failCount" integer NOT NULL DEFAULT 0,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    // Unique: the upsert target. Without it, concurrent ticks from two lambda
    // instances would insert duplicate rows for the same job and "last run"
    // would depend on which one you happened to read.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_job_runs_name" ON "job_runs" ("jobName")`,
    );

    await queryRunner.query(`ALTER TABLE "job_runs" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "job_runs" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(
      `DROP POLICY IF EXISTS platform_global_read ON "job_runs"`,
    );
    await queryRunner.query(`
      CREATE POLICY platform_global_read ON "job_runs" FOR SELECT TO public
        USING (true)
    `);
    await queryRunner.query(
      `DROP POLICY IF EXISTS platform_global_write ON "job_runs"`,
    );
    await queryRunner.query(`
      CREATE POLICY platform_global_write ON "job_runs" FOR ALL TO public
        USING (app.rls_bypassed()) WITH CHECK (app.rls_bypassed())
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "job_runs"`);
  }
}
