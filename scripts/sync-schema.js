// One-off: materialize the schema directly from the validated TypeORM entities.
// Used because the hand-written migrations are mutually inconsistent and have
// never run against a fresh DB (snake_case tenant_id vs camelCase "tenantId",
// missing `app` schema/functions, table-name typos). The entities pass metadata
// validation and are what the app actually queries, so they are the source of truth.
//
// Run from repo root AFTER `npm run build`:  node scripts/sync-schema.js
require('dotenv').config();
const path = require('path');
const { DataSource } = require('typeorm');

// Neon hands out a single connection string; prefer it and fall back to the
// discrete vars for local/legacy setups.
const connection = process.env.DATABASE_URL
  ? { url: process.env.DATABASE_URL }
  : {
      host: process.env.DATABASE_HOST,
      port: parseInt(process.env.DATABASE_PORT || '5432', 10),
      username: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
    };

const ds = new DataSource({
  type: 'postgres',
  ...connection,
  entities: [path.join(__dirname, '..', 'dist', 'src', '**', '*.entity.js')],
  synchronize: false, // we call synchronize() manually after an optional drop
  logging: ['error', 'schema'],
  ssl: { rejectUnauthorized: false },
});

(async () => {
  await ds.initialize();

  // DROP=1 → wipe all public tables first for a clean materialization.
  if (process.env.DROP === '1') {
    await ds.query(`
      DO $$ DECLARE r record;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `);
    console.log('Dropped all public tables.');
  }

  await ds.synchronize();
  const tables = await ds.query(
    "select count(*)::int n from information_schema.tables where table_schema='public'",
  );
  console.log('SYNC OK — public tables now:', tables[0].n);
  await ds.destroy();
})().catch((e) => {
  console.error('SYNC FAILED:', e.message);
  process.exit(1);
});
