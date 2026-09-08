import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Give `universal_entities` a generic lifecycle: status, dueDate, assignedTo.
 *
 * GovernanceX needs obligations and breaches, and ImmiStack needs a case
 * kanban. All three are records with a state, an owner and a deadline. Rather
 * than add vertical-specific tables — which CLAUDE.md §11.3 forbids in core —
 * they become `universal_entities` rows with `type` of `obligation`, `breach`
 * or the already-present `case`.
 *
 * These three fields were previously expected to live in `verticalAttributes`,
 * but every screen that shows them filters and sorts by them, and a jsonb
 * predicate cannot use an index the way a column can. The entity file's own
 * guidance said to lift such fields to top-level columns; this does that.
 *
 * The vocabulary stays neutral. `entity_status_enum` is a generic set of
 * states; a vertical maps its own labels (GovernanceX's remediation stages,
 * ImmiStack's kanban columns) onto them in its config pack.
 */
export class AddEntityLifecycleColumns1753700000000 implements MigrationInterface {
  name = 'AddEntityLifecycleColumns1753700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // New entity types. ADD VALUE cannot run inside a transaction block in
    // older Postgres and is not reversible, hence IF NOT EXISTS and the
    // one-way `down` note below.
    await queryRunner.query(
      `ALTER TYPE "universal_entities_type_enum" ADD VALUE IF NOT EXISTS 'obligation'`,
    );
    await queryRunner.query(
      `ALTER TYPE "universal_entities_type_enum" ADD VALUE IF NOT EXISTS 'breach'`,
    );

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'entity_status_enum') THEN
          CREATE TYPE "entity_status_enum" AS ENUM (
            'open', 'in_progress', 'blocked', 'resolved', 'closed', 'cancelled'
          );
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "universal_entities"
        ADD COLUMN IF NOT EXISTS "status" "entity_status_enum",
        ADD COLUMN IF NOT EXISTS "dueDate" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "assignedTo" UUID
    `);

    // Matches the three real access patterns: a tenant's records of one type by
    // state, one user's workload, and what is coming due.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_universal_entities_tenant_type_status"
        ON "universal_entities" ("tenantId", "type", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_universal_entities_tenant_assignee"
        ON "universal_entities" ("tenantId", "assignedTo")
        WHERE "assignedTo" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_universal_entities_tenant_due"
        ON "universal_entities" ("tenantId", "dueDate")
        WHERE "dueDate" IS NOT NULL
    `);

    // The table already carries `tenantId` and so was picked up by the
    // catalog-driven policy loop in AddTenantRowLevelSecurity. Adding columns
    // does not change that — `tenant_isolation` applies to the whole row — so
    // there is no policy work here. Verified by `npm run rls:verify`.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_universal_entities_tenant_due"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_universal_entities_tenant_assignee"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_universal_entities_tenant_type_status"`,
    );
    await queryRunner.query(`
      ALTER TABLE "universal_entities"
        DROP COLUMN IF EXISTS "assignedTo",
        DROP COLUMN IF EXISTS "dueDate",
        DROP COLUMN IF EXISTS "status"
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS "entity_status_enum"`);

    // The two new members of universal_entities_type_enum are intentionally
    // left in place: Postgres cannot drop an enum value, and recreating the
    // type would require rewriting every row that references it. They are inert
    // once no row uses them.
  }
}
