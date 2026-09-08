#!/usr/bin/env node
/**
 * Marks already-materialised migrations as applied, without re-running them.
 *
 * The schema on this database was created by scripts/sync-schema.js rather than
 * by TypeORM, so all 51 tables exist while the `migrations` table is empty.
 * TypeORM therefore tries to replay `InitialSchema` and dies on 42P07
 * (relation already exists), which blocks every *new* migration behind it.
 *
 * This records the pre-existing migrations as done so the executor moves on to
 * genuinely pending ones. It never executes migration SQL.
 *
 * Usage:
 *   node scripts/baseline-migrations.js            # dry run, shows the plan
 *   node scripts/baseline-migrations.js --apply
 *   node scripts/baseline-migrations.js --apply --through 1744010000000
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'dist', 'src', 'migrations');

function discover() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`No compiled migrations at ${MIGRATIONS_DIR} — run: npm run build`);
    process.exit(1);
  }

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.d.js'))
    .map((file) => {
      const mod = require(path.join(MIGRATIONS_DIR, file));
      const exported = Object.values(mod).find((v) => typeof v === 'function');
      if (!exported) return null;
      // TypeORM keys the migrations table on the instance `name` when the class
      // sets one, falling back to the constructor name.
      const instance = new exported();
      const name = instance.name || exported.name;
      const timestamp = parseInt(file.split('-')[0], 10);
      return { file, name, timestamp };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const throughArg = process.argv.indexOf('--through');
  const through =
    throughArg !== -1 ? parseInt(process.argv[throughArg + 1], 10) : null;

  const migrations = discover().filter((m) =>
    through === null ? true : m.timestamp <= through,
  );

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        timestamp bigint NOT NULL,
        name character varying NOT NULL
      )
    `);

    const { rows: existing } = await client.query('SELECT name FROM migrations');
    const already = new Set(existing.map((r) => r.name));

    const pending = migrations.filter((m) => !already.has(m.name));

    console.log(`\nCompiled migrations found : ${migrations.length}`);
    console.log(`Already recorded          : ${already.size}`);
    console.log(`Will be marked as applied : ${pending.length}\n`);
    pending.forEach((m) => console.log(`  ${m.timestamp}  ${m.name}`));

    if (!apply) {
      console.log('\nDry run. Re-run with --apply to record these.\n');
      return;
    }

    for (const m of pending) {
      await client.query(
        'INSERT INTO migrations (timestamp, name) VALUES ($1, $2)',
        [m.timestamp, m.name],
      );
    }
    console.log(`\nRecorded ${pending.length} migration(s) as applied.\n`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('Baseline failed:', error.message);
  process.exit(1);
});
