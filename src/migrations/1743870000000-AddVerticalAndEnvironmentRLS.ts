import { MigrationInterface, QueryRunner } from 'typeorm';

// NOTE (2026-06-27): Disabled along with AddRowLevelSecurity1743860000000.
// This migration layered vertical/environment RLS on top of the broken base RLS
// (which referenced a non-existent `app` schema and snake_case `tenant_id`).
// Stubbed to a no-op so the schema can build; RLS to be reimplemented correctly
// against the real `"tenantId"` columns (CLAUDE.md §6.4). Original SQL in git history.
export class AddVerticalAndEnvironmentRLS1743870000000 implements MigrationInterface {
  name = 'AddVerticalAndEnvironmentRLS1743870000000';

  public async up(_queryRunner: QueryRunner): Promise<void> {
    // no-op — see note above
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // no-op
  }
}
