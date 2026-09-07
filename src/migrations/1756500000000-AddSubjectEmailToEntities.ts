import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `universal_entities.subjectEmail` — the email of the person a record is
 * ABOUT, as distinct from `email`, which identifies a person record itself.
 *
 * Why this exists: `CrmController.clientScoped` scoped a `client`-role caller
 * to `assignedTo: user.id`, but `assignedTo` is the *staff* owner. A client's
 * query therefore matched nothing, and `/client/home`, `/client/documents` and
 * `/client/payments` rendered "no case yet" for every real applicant. There
 * was no correct field to scope on, because "the records belonging to this
 * client" was a question the data model could not answer.
 *
 * The column is nullable and additive, and the backfill below only writes rows
 * that are currently NULL, so this is reversible and cannot disturb a record
 * anyone has since corrected by hand.
 *
 * RLS: `universal_entities` already carries ENABLE + FORCE row-level security
 * with `tenantId` policies. Adding a column inherits them; no policy change is
 * needed, and none is made here.
 */
export class AddSubjectEmailToEntities1756500000000
  implements MigrationInterface
{
  name = 'AddSubjectEmailToEntities1756500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "universal_entities" ADD COLUMN IF NOT EXISTS "subjectEmail" character varying`,
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_universal_entities_tenant_subject_email"
       ON "universal_entities" ("tenantId", "subjectEmail")`,
    );

    // ── Backfill ────────────────────────────────────────────────────────────
    //
    // Without this the fix is correct and inert: every case that already exists
    // keeps a NULL subject and stays invisible to its own applicant.
    //
    // The JSON path below IS immigration vocabulary, and core does not
    // otherwise carry any (CLAUDE.md §5.5). It is confined to this one-off data
    // repair on purpose — nothing on a runtime path reads it, and the
    // alternative is asking every existing firm to re-key their caseload. The
    // runtime write is generic: callers set `subjectEmail` explicitly.
    //
    // `LOWER(TRIM(...))` because the value is matched against a JWT email, and
    // the frontend previously compared these case-insensitively after trimming.
    // Only rows that are still NULL are touched.
    await queryRunner.query(`
      UPDATE "universal_entities"
         SET "subjectEmail" = LOWER(TRIM("verticalAttributes"->'applicant_details'->>'email'))
       WHERE "subjectEmail" IS NULL
         AND "verticalAttributes"->'applicant_details'->>'email' IS NOT NULL
         AND TRIM("verticalAttributes"->'applicant_details'->>'email') <> ''
    `);

    // A person record is its own subject. This makes the client portal's
    // person lookups work on the same filter as its case lookups, rather than
    // needing a second code path.
    await queryRunner.query(`
      UPDATE "universal_entities"
         SET "subjectEmail" = LOWER(TRIM("email"))
       WHERE "subjectEmail" IS NULL
         AND "type" = 'person'
         AND "email" IS NOT NULL
         AND TRIM("email") <> ''
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_universal_entities_tenant_subject_email"`,
    );
    await queryRunner.query(
      `ALTER TABLE "universal_entities" DROP COLUMN IF EXISTS "subjectEmail"`,
    );
  }
}
