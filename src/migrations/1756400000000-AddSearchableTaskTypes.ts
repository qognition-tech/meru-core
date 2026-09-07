import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `task`, `form_submission`, `workflow_instance` on `search_index.searchableType`.
 *
 * `SearchService.indexEntityData` hardcoded `SearchableType.ENTITY` for every
 * write regardless of what a caller asked to index, so `task.service.ts`,
 * `form-builder.service.ts` and `workflow.service.ts` — which each pass a
 * wrapper object carrying their own `searchableType` string — were silently
 * mis-typed even before the id bug (same commit) was fixed. `document` already
 * existed and covers `document-hub.service.ts`'s wrapper.
 *
 * `ADD VALUE IF NOT EXISTS` is not transactional on older Postgres, so this
 * migration deliberately does nothing else — same pattern as
 * AddSarEntityType/AddWhatsappChannel/AddGovxEntityTypes.
 *
 * The type is `search_index_searchabletype_enum`, not `searchable_type_enum`.
 * TypeORM derives an enum's name as `<table>_<column>_enum`, lower-cased — the
 * same convention as `universal_entities_type_enum` and `notifications_type_enum`
 * in the sibling migrations. This migration originally named a type that has
 * never existed, so it failed with 42704 on first run and blocked every
 * migration queued behind it, including AddSubjectEmailToEntities. Nothing
 * caught it because migrations are not exercised by the unit suite and this
 * host could not reach a database.
 */
export class AddSearchableTaskTypes1756400000000 implements MigrationInterface {
  name = 'AddSearchableTaskTypes1756400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "search_index_searchabletype_enum" ADD VALUE IF NOT EXISTS 'task'`,
    );
    await queryRunner.query(
      `ALTER TYPE "search_index_searchabletype_enum" ADD VALUE IF NOT EXISTS 'form_submission'`,
    );
    await queryRunner.query(
      `ALTER TYPE "search_index_searchabletype_enum" ADD VALUE IF NOT EXISTS 'workflow_instance'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop a value from an enum without recreating the type
    // and rewriting every dependent column. An unused enum value costs
    // nothing — same reasoning as AddSarEntityType's down().
  }
}
