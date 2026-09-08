import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WORM (write-once-read-many) enforcement for `audit_logs` — CLAUDE.md §6.5.
 *
 * The log was already tamper-*evident*: every row carries a checksum and a
 * `chainHash` linking it to its predecessor, so an edit can be detected by
 * re-walking the chain. It was not tamper-*resistant*: nothing stopped an
 * UPDATE or DELETE. Detection alone is a weak claim to make to a regulator,
 * because it only holds if somebody re-verifies the chain, and a deletion
 * breaks the chain in exactly the same way a legitimate gap would.
 *
 * Enforced with a trigger rather than an RLS policy on purpose. RLS is
 * bypassed by any role holding BYPASSRLS — which the migration/owner role
 * does — so a policy would protect the log from the application while leaving
 * it open to the connection most likely to be used for an ad-hoc "cleanup".
 * Triggers fire regardless of BYPASSRLS.
 *
 * One exception is carved out: `archived`. The retention job
 * (AuditService.archiveOldLogs) flips that flag on rows past the retention
 * window, and it is metadata about storage, not about what happened. Every
 * other column is frozen, compared as whole rows so a column added later is
 * protected automatically rather than needing this trigger to be remembered.
 *
 * Remaining exposure, stated plainly: a superuser can `ALTER TABLE ... DISABLE
 * TRIGGER` or drop it. Postgres has no construct that survives its own
 * superuser. Genuine WORM needs storage the database cannot reach — periodic
 * export to object storage with an immutability lock (S3 Object Lock in
 * compliance mode). This migration closes the application- and
 * owner-level holes; the export is a separate piece of work.
 */
export class AddAuditWormEnforcement1755200000000 implements MigrationInterface {
  name = 'AddAuditWormEnforcement1755200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app.audit_logs_worm()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'audit_logs is append-only (WORM): DELETE is not permitted. '
            'Retention is handled by archiving, not deletion.'
            USING ERRCODE = 'restrict_violation';
        END IF;

        -- Whole-row comparison minus the one mutable column, so any column
        -- added to this table in future is frozen by default. Enumerating
        -- columns here would mean a new one is writable until somebody
        -- remembers to add it, which is the wrong default for an audit log.
        IF (to_jsonb(NEW) - 'archived') IS DISTINCT FROM (to_jsonb(OLD) - 'archived') THEN
          RAISE EXCEPTION
            'audit_logs is append-only (WORM): only the "archived" flag may '
            'change. Attempted to modify a sealed audit record (id=%).', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;

        RETURN NEW;
      END;
      $$;
    `);

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS audit_logs_worm_guard ON public.audit_logs`,
    );
    await queryRunner.query(`
      CREATE TRIGGER audit_logs_worm_guard
        BEFORE UPDATE OR DELETE ON public.audit_logs
        FOR EACH ROW EXECUTE FUNCTION app.audit_logs_worm()
    `);

    // Row triggers never see TRUNCATE, which would empty the table without
    // firing the guard above — the single most destructive operation this is
    // meant to prevent.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app.audit_logs_no_truncate()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION
          'audit_logs is append-only (WORM): TRUNCATE is not permitted.'
          USING ERRCODE = 'restrict_violation';
      END;
      $$;
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS audit_logs_no_truncate_guard ON public.audit_logs`,
    );
    await queryRunner.query(`
      CREATE TRIGGER audit_logs_no_truncate_guard
        BEFORE TRUNCATE ON public.audit_logs
        FOR EACH STATEMENT EXECUTE FUNCTION app.audit_logs_no_truncate()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS audit_logs_worm_guard ON public.audit_logs`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS audit_logs_no_truncate_guard ON public.audit_logs`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS app.audit_logs_worm()`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS app.audit_logs_no_truncate()`,
    );
  }
}
