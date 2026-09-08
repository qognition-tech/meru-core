import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Storage for ingested sanctions/PEP lists. Platform-global like
 * vessel_positions — a government designation is not tenant-specific, and
 * duplicating ~17k OFAC rows per tenant would be wasteful and semantically
 * wrong. Reads are open to every bound tenant; writes require the system
 * bypass, so only the ingestion job can author rows.
 */
export class AddWatchlistEntries1754900000000 implements MigrationInterface {
  name = 'AddWatchlistEntries1754900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "watchlist_entries" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "externalId" character varying(100) NOT NULL,
        "listSource" character varying(50) NOT NULL,
        "name" text NOT NULL,
        "normalizedName" text NOT NULL,
        "aliases" text[] NOT NULL DEFAULT '{}',
        "entityType" character varying(30) NOT NULL DEFAULT 'individual',
        "country" character varying(2),
        "programs" text[] NOT NULL DEFAULT '{}',
        "remarks" text,
        "lastSeenAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_watchlist_source" ON "watchlist_entries" ("listSource")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_watchlist_normalized" ON "watchlist_entries" ("normalizedName")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_watchlist_source_external" ON "watchlist_entries" ("listSource", "externalId")`,
    );

    await queryRunner.query(
      `ALTER TABLE "watchlist_entries" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "watchlist_entries" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS platform_global_read ON "watchlist_entries"`,
    );
    await queryRunner.query(`
      CREATE POLICY platform_global_read ON "watchlist_entries" FOR SELECT TO public
        USING (true)
    `);
    await queryRunner.query(
      `DROP POLICY IF EXISTS platform_global_write ON "watchlist_entries"`,
    );
    await queryRunner.query(`
      CREATE POLICY platform_global_write ON "watchlist_entries" FOR ALL TO public
        USING (app.rls_bypassed()) WITH CHECK (app.rls_bypassed())
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "watchlist_entries"`);
  }
}
