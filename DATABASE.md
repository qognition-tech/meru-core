# Database (live)

Meru Core runs on **Neon Postgres**. Connection strings live in `.env` (git-ignored);
`.env.example` documents every variable.

> **Supabase is no longer used.** An earlier iteration ran on Supabase
> (project `fkkumtpbdedjagwhnbjc`). The dependency (`@supabase/supabase-js`),
> the `SupabaseConfigService`, and all `SUPABASE_*` variables have been removed —
> nothing in `src/` reads them. Only a comment in the historical migration
> `1744000000000-AlignAllTablesToSchema.ts` still mentions it.

## Two roles, on purpose

| Env var            | Role       | Used for                  |
|--------------------|------------|---------------------------|
| `DATABASE_URL`     | owner      | migrations / DDL only     |
| `DATABASE_APP_URL` | `meru_app` | **application runtime**   |

Row-level security is **silently inert** for any role holding `BYPASSRLS`, and that
is the default for managed-Postgres owner accounts (Neon's `neondb_owner`,
Supabase's `postgres`, RDS masters). Connecting the app as the owner leaves every
tenant policy in place as decoration: `relrowsecurity` reads true and nothing is
filtered. Hence the split — see CLAUDE.md §6.4 and DEPLOY.md.

```bash
node scripts/provision-rls-role.js --write-env   # creates meru_app, writes DATABASE_APP_URL
npm run rls:verify                               # proves isolation actually holds
```

`rls:verify` connects as `meru_app` and attempts real cross-tenant reads, inserts,
updates and deletes. It exits non-zero on any failure, so it is safe as a deploy gate.

## Schema

51 tables. The schema is owned by the TypeORM migrations in `src/migrations/`.

Historical note: the migration chain could not originally run against a fresh DB
(snake_case `tenant_id` vs the camelCase `"tenantId"` the entities actually use, a
missing `app` schema, and a `search_indexes`/`search_index` typo). The schema was
first materialized directly from the entities with `scripts/sync-schema.js`, and the
three legacy RLS migrations were stubbed to no-ops. Tenant isolation is now
implemented properly in `1753500000000-AddTenantRowLevelSecurity`, which creates the
`app` schema, the `meru_app` role, and `ENABLE`+`FORCE` RLS policies on every table.

```bash
npm run migration:run
```

If the schema was created outside TypeORM the `migrations` table will be empty and
TypeORM will replay `InitialSchema`, failing with `42P07 relation already exists`.
Baseline it once:

```bash
node scripts/baseline-migrations.js --apply --through 1744010000000
```

To (re)provision a schema on a new/empty DB from the entities instead:

```bash
npm run build
node scripts/sync-schema.js          # create tables from entities
DROP=1 node scripts/sync-schema.js   # wipe public tables first, then recreate
```

## Config packs

`config_packs` is a **platform-global** table (readable by every tenant, writable
only under an RLS bypass), because packs are shared platform artifacts —
see CLAUDE.md §4. `ConfigPackLoaderService` seeds
`packages/config-packs/**/*.json` at boot inside `TenantContext.runAsSystem`;
without that bypass the `platform_global_write` policy rejects every insert.

Pack `code` must match `^[a-z]{2}-[a-z_]+$` (e.g. `au-immigration`). That is the
*pack code*, not the directory layout — packs live at `<country>/<vertical>.json`.
The Zod validator (`_schema/pack.schema.ts`) and the JSON Schema
(`_schema/config-pack.schema.json`) must agree; they drifted once and every pack
silently failed to load.

## Known gaps

- Elasticsearch is optional and not configured; the connection warning at boot is
  harmless and search falls back to Postgres.
- Redis is **not** required. The job queue is Postgres-backed (`queue_jobs` +
  `QueueService.getNextJob`); `REDIS_HOST` only selects the cache store and falls
  back to in-memory. An earlier `BullModule` registration opened an ioredis
  connection that retried forever during module init, silently blocking bootstrap
  on any machine without Redis — that has been removed.
