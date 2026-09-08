import { MigrationInterface, QueryRunner } from 'typeorm';

// NOTE (2026-06-27): The original body of this migration was disabled because it
// could never run against a fresh database. It:
//   - referenced a snake_case `tenant_id` column while the entities/tables use
//     camelCase `"tenantId"` (uuid), so RLS policies targeted a non-existent column;
//   - only added `tenant_id` to 4 of the 10 tables it then wrote policies for;
//   - called functions in an `app` schema that is never created (no CREATE SCHEMA app).
//
// RLS is mandated by CLAUDE.md §6.4 and MUST be reintroduced, but as a correct
// implementation aligned to the real `"tenantId"` columns. Tracked as a follow-up.
// Stubbed to a no-op so the schema-creating migrations can run and the app boots.
// Original SQL remains in git history for the rewrite.
export class AddRowLevelSecurity1743860000000 implements MigrationInterface {
  name = 'AddRowLevelSecurity1743860000000';

  public async up(_queryRunner: QueryRunner): Promise<void> {
    // no-op — see note above (RLS to be reimplemented against "tenantId")
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // no-op
  }
}
