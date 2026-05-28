## scripts/

Ad-hoc Node scripts for local dev DB lifecycle. Not part of the build.

- `setup-db.js` — bootstrap a fresh dev database (creates schema, seeds minimal data)
- `reset-db.js` — drop and recreate all tables (DEV ONLY)
- `check-db.js` — quick connection + table-presence sanity check
- `test-db.js` — exercise basic read/write against the current schema

Production schema changes go through TypeORM migrations under `src/migrations/`,
not through these scripts. Run with `pnpm run migration:run`.
