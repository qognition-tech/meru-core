import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `entity_relations` — one generic edge table for every typed relationship a
 * vertical declares.
 *
 * The jsonb `relationships` array on `universal_entities` could only be read
 * forwards, could not be indexed, and carried a free-text type no pack
 * validated. "What blocks this task?" was unanswerable, which is the half of a
 * dependency that matters.
 *
 * Additive: the jsonb column stays and keeps working. Backfilling it into this
 * table needs the pack to declare `relationships[]` for the edge types already
 * in use, so it is deliberately not attempted here — a migration that invents
 * relation keys would create edges that match no definition, which is the
 * problem this table exists to end.
 *
 * Tenant-scoped, ENABLE + FORCE, per CLAUDE.md §6.4.
 */
export class AddEntityRelations1755700000000 implements MigrationInterface {
  name = 'AddEntityRelations1755700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "entity_relations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "relationKey" character varying(100) NOT NULL,
        "fromId" uuid NOT NULL,
        "fromType" character varying(50) NOT NULL,
        "toId" uuid NOT NULL,
        "toType" character varying(50) NOT NULL,
        "createdBy" uuid,
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_entity_relations_tenant" ON "entity_relations" ("tenantId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_entity_relations_from" ON "entity_relations" ("tenantId","fromId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_entity_relations_to" ON "entity_relations" ("tenantId","toId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_entity_relations_edge" ON "entity_relations" ("tenantId","relationKey","fromId","toId")`,
    );

    await queryRunner.query(
      `ALTER TABLE "entity_relations" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "entity_relations" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "entity_relations"`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "entity_relations" FOR ALL TO public
        USING (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
        WITH CHECK (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "entity_relations"`);
  }
}
