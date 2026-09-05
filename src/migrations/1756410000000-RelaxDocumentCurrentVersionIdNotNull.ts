import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `documents."currentVersionId"` was created `uuid NOT NULL`
 * (1743859200000-AddDocumentHubTables.ts), but the entity has always
 * declared it `@Column({ type: 'uuid', nullable: true })` — a drift
 * `synchronize: false` (app.module.ts) never caught.
 *
 * `DocumentsService.create()` built a metadata-only document row — no
 * version exists yet at that point, since the file lands later via
 * `upload()` or `createNewVersion()` — and wrote `currentVersionId: ''` to
 * satisfy the NOT NULL constraint. `''` is not a valid uuid, so Postgres
 * rejected it at parse time before the NOT NULL check ever ran:
 * `invalid input syntax for type uuid: ""`, 500ing every `POST /documents`
 * call, unconditionally.
 *
 * The fix is to stop writing a fake value and write `null`, which is what
 * the entity already promised the rest of the codebase. This migration
 * makes the column agree. Additive and reversible: no existing row is
 * touched, and every row written before this migration already carries a
 * real uuid (the empty-string defect never reached storage, because
 * Postgres rejected the insert first — `GET /documents` on the probe tenant
 * returns `totalItems: 0`).
 *
 * Renumbered 1756400000000 -> 1756410000000 during the 2026-09-06 integration
 * of `fix/crm-entity-actor-scoping` onto `origin/main`: `main` had, in the
 * meantime, independently registered a *different* migration
 * (`AddSearchableTaskTypes`) at the same 1756400000000 timestamp. Renumbering
 * this one — not yet deployed anywhere — avoids a same-timestamp collision in
 * `ALL_MIGRATIONS`'s sort/order rather than touching an already-registered one.
 */
export class RelaxDocumentCurrentVersionIdNotNull1756410000000
  implements MigrationInterface
{
  name = 'RelaxDocumentCurrentVersionIdNotNull1756410000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" ALTER COLUMN "currentVersionId" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Only safe to reverse while every row still has a value. If any
    // metadata-only document rows exist (currentVersionId IS NULL) this will
    // fail with a NOT NULL violation, which is the correct outcome — a blind
    // revert would otherwise silently truncate/replace live nulls.
    await queryRunner.query(
      `ALTER TABLE "documents" ALTER COLUMN "currentVersionId" SET NOT NULL`,
    );
  }
}
