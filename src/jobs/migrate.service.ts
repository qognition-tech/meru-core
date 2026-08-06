import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ALL_MIGRATIONS } from '../config/migrations';
import { ALL_ENTITIES } from '../config/entities';
import { AddTenantRowLevelSecurity1753500000000 } from '../migrations/1753500000000-AddTenantRowLevelSecurity';
import { AddVesselPositions1754200000000 } from '../migrations/1754200000000-AddVesselPositions';
import { AddTenantConnectors1754700000000 } from '../migrations/1754700000000-AddTenantConnectors';

export type MigrateTarget = 'control' | 'govx' | 'immistack';

/**
 * Runs the bundled migration chain against one of the three databases, from
 * the deployed environment. Exists because the vertical DBs (three-DB split)
 * need the full chain applied and deploy infrastructure has the fast disks —
 * the local CLI path stays for development.
 *
 * Uses the OWNER url for the target (DDL needs it); the connection lives only
 * for the duration of the call. Guarded by CronSecretGuard at the controller —
 * this is a machine endpoint, not a user surface.
 */
@Injectable()
export class MigrateService {
  private readonly logger = new Logger(MigrateService.name);

  private ownerUrlFor(target: MigrateTarget): string | undefined {
    switch (target) {
      case 'control':
        return process.env.DATABASE_URL;
      case 'govx':
        return process.env.GOVX_DB_URL;
      case 'immistack':
        return process.env.IMMISTACK_DB_URL;
    }
  }

  /** No public tables ⇒ never provisioned, so bootstrap rather than migrate. */
  private async isEmptyDatabase(ds: DataSource): Promise<boolean> {
    const rows = await ds.query<{ count: string }[]>(
      `SELECT count(*)::text AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    return Number(rows?.[0]?.count ?? 0) === 0;
  }

  async migrate(target: MigrateTarget): Promise<{
    target: MigrateTarget;
    executed: string[];
    alreadyApplied: boolean;
  }> {
    const url = this.ownerUrlFor(target);
    if (!url) {
      throw new BadRequestException(
        `No owner database URL configured for target '${target}'`,
      );
    }

    const ds = new DataSource({
      type: 'postgres',
      url,
      entities: ALL_ENTITIES,
      migrations: ALL_MIGRATIONS,
      // 'each': fresh databases run the whole chain in one call, and enum
      // ADD VALUE + later use must not share one giant transaction.
      migrationsTransactionMode: 'each',
      ssl: { rejectUnauthorized: false },
      extra: { max: 1, connectionTimeoutMillis: 15000 },
    });

    await ds.initialize();
    try {
      // A brand-new Neon database has neither extension, and the migration
      // chain calls uuid_generate_v4()/gen_random_uuid() from the very first
      // migration. The control-plane DB only has them because they were
      // installed by hand before the chain ever ran there.
      await ds.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      await ds.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

      // The `app` schema and `app.has_access()` are referenced by
      // 1743900000000 and 1743910000000 but created by NO migration — the
      // control-plane database only survived because it was baselined
      // (scripts/baseline-migrations.js) rather than migrated from empty. A
      // genuinely fresh database therefore cannot run the chain at all.
      //
      // Seeded permissively here on purpose: the vertical/environment policies
      // those two migrations declare are superseded by the tenant_isolation
      // policies in 1753500000000, which is the isolation that actually holds
      // (and which `npm run rls:verify` proves). A restrictive stub would
      // silently deny every row instead.
      await ds.query('CREATE SCHEMA IF NOT EXISTS app');
      await ds.query(`
        CREATE OR REPLACE FUNCTION app.has_access(text, text) RETURNS boolean
        LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
      `);
      // Attached as a BEFORE INSERT OR UPDATE trigger on ~20 tables by the
      // same two migrations, and likewise never defined. A no-op preserves
      // the insert exactly as the application wrote it — the entities set
      // their own vertical/environment/tenant columns, and RLS is what
      // enforces isolation, not this trigger.
      await ds.query(`
        CREATE OR REPLACE FUNCTION app.set_context_fields() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      `);

      // An empty database is BOOTSTRAPPED, not migrated.
      //
      // The migration chain cannot run from empty: several 2025 migrations
      // reference columns and functions that only exist because the
      // control-plane database was built incrementally and then baselined
      // (scripts/baseline-migrations.js). Replaying it against a fresh Neon
      // database dies on undefined functions and missing columns, and
      // "fix each error as it surfaces" would rewrite history that production
      // already depends on.
      //
      // So: build the schema from entity metadata (the same definitions the
      // app runs against — no drift possible), apply the RLS migration
      // explicitly because synchronize knows nothing about policies, then
      // record every migration as applied so future incremental migrations
      // run normally on top.
      const isEmpty = await this.isEmptyDatabase(ds);
      if (isEmpty) {
        this.logger.log(`Bootstrapping empty database '${target}' from entities`);
        await ds.synchronize();
        await ds.query(`
          CREATE TABLE IF NOT EXISTS migrations (
            id SERIAL PRIMARY KEY,
            timestamp bigint NOT NULL,
            name character varying NOT NULL
          )
        `);

        // synchronize() creates tables but knows nothing about policies, so
        // every migration that carries RLS has to be replayed. These three are
        // idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS), and rls:verify
        // fails the deploy if any table is left uncovered.
        const rlsMigrations = [
          new AddTenantRowLevelSecurity1753500000000(),
          new AddVesselPositions1754200000000(),
          new AddTenantConnectors1754700000000(),
        ];
        const runner = ds.createQueryRunner();
        try {
          await runner.connect();
          for (const migration of rlsMigrations) {
            await migration.up(runner);
          }
        } finally {
          await runner.release();
        }

        for (const m of ALL_MIGRATIONS) {
          const name = m.name;
          const timestamp = Number(/(\d{13})$/.exec(name)?.[1] ?? Date.now());
          await ds.query(
            'INSERT INTO migrations (timestamp, name) VALUES ($1, $2)',
            [timestamp, name],
          );
        }

        this.logger.log(
          `Bootstrapped '${target}': schema from entities + RLS, ${ALL_MIGRATIONS.length} migrations baselined`,
        );
        return {
          target,
          executed: [`bootstrap (${ALL_MIGRATIONS.length} baselined)`],
          alreadyApplied: false,
        };
      }

      const executed = await ds.runMigrations({ transaction: 'each' });
      this.logger.log(
        `Migrated '${target}': ${executed.length} migration(s) executed`,
      );
      return {
        target,
        executed: executed.map((m) => m.name),
        alreadyApplied: executed.length === 0,
      };
    } finally {
      await ds.destroy();
    }
  }
}
