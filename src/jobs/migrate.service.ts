import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ALL_MIGRATIONS } from '../config/migrations';

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
