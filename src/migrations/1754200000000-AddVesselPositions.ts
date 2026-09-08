import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Store the latest AIS state per vessel.
 *
 * Vessel tracking previously depended entirely on a commercial HTTP AIS API
 * (`AIS_API_URL`/`AIS_API_KEY`). With none configured every vessel reported
 * `ais_not_configured` and the feature was inert. This table plus the ingest
 * endpoint make it work with any AIS source — a dockside receiver, an
 * aggregator feed — by accepting raw NMEA or decoded positions.
 *
 * **Platform-global, deliberately.** A ship's position is a public VHF
 * broadcast, not one tenant's data: two banks watching the same tanker must
 * see the same position, and per-tenant copies would drift. Same treatment as
 * `config_packs` — readable by every tenant, writable only under bypass, so no
 * tenant can poison another's view.
 */
export class AddVesselPositions1754200000000 implements MigrationInterface {
  name = 'AddVesselPositions1754200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "vessel_positions" (
        "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "mmsi"        VARCHAR(16) NOT NULL,
        "imo"         VARCHAR(16),
        "name"        VARCHAR(200),
        "callSign"    VARCHAR(16),
        "shipType"    VARCHAR(64),
        "flag"        VARCHAR(8),
        "lat"         DOUBLE PRECISION,
        "lon"         DOUBLE PRECISION,
        "sog"         DOUBLE PRECISION,
        "cog"         DOUBLE PRECISION,
        "heading"     DOUBLE PRECISION,
        "navStatus"   VARCHAR(64),
        "destination" VARCHAR(120),
        "lastSeenAt"  TIMESTAMPTZ NOT NULL,
        "source"      VARCHAR(32) NOT NULL DEFAULT 'nmea',
        "updatedAt"   TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    // One row per vessel, updated in place — the unique index is what makes
    // the upsert path correct.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_vessel_positions_mmsi" ON "vessel_positions" ("mmsi")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_vessel_positions_imo" ON "vessel_positions" ("imo") WHERE "imo" IS NOT NULL`,
    );
    // Dark-period detection asks "which watched vessels have gone quiet".
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_vessel_positions_last_seen" ON "vessel_positions" ("lastSeenAt")`,
    );

    // Platform-global policy pair, mirroring GLOBAL_TABLES in
    // AddTenantRowLevelSecurity. That migration has already run, so a new table
    // gets no policy retroactively and would otherwise be wide open.
    await queryRunner.query(
      `ALTER TABLE "vessel_positions" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "vessel_positions" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS platform_global_read ON "vessel_positions"`,
    );
    await queryRunner.query(`
      CREATE POLICY platform_global_read ON "vessel_positions" FOR SELECT TO public
        USING (true)
    `);
    await queryRunner.query(
      `DROP POLICY IF EXISTS platform_global_write ON "vessel_positions"`,
    );
    await queryRunner.query(`
      CREATE POLICY platform_global_write ON "vessel_positions" FOR ALL TO public
        USING (app.rls_bypassed()) WITH CHECK (app.rls_bypassed())
    `);
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "vessel_positions" TO meru_app`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "vessel_positions"`);
  }
}
