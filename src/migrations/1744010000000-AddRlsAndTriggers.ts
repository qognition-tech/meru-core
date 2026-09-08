import { MigrationInterface, QueryRunner } from 'typeorm';

// NOTE (2026-06-27): Disabled along with AddRowLevelSecurity1743860000000.
// This migration added further RLS policies + tenant-id triggers using the same
// snake_case `tenant_id` / `app` schema assumptions that don't match the actual
// camelCase `"tenantId"` schema. Stubbed to a no-op so the schema can build;
// RLS + triggers to be reimplemented correctly (CLAUDE.md §6.4). SQL in git history.
export class AddRlsAndTriggers1744010000000 implements MigrationInterface {
  name = 'AddRlsAndTriggers1744010000000';

  public async up(_queryRunner: QueryRunner): Promise<void> {
    // no-op — see note above
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // no-op
  }
}
