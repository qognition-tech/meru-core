# Supabase project (live)

The original project `kgkeibbudhpalkkgcgaz` (name "meru-core") was **paused/removed**
and unreachable. A fresh project was provisioned via the Supabase CLI.

| Field | Value |
|---|---|
| Name | `meru-core-prod` |
| Project ref | `fkkumtpbdedjagwhnbjc` |
| Region | `ap-south-1` |
| Dashboard | https://supabase.com/dashboard/project/fkkumtpbdedjagwhnbjc |
| API URL | https://fkkumtpbdedjagwhnbjc.supabase.co |
| DB pooler host | `aws-1-ap-south-1.pooler.supabase.com` (session pooler `:5432`, txn pooler `:6543`) |
| DB user | `postgres.fkkumtpbdedjagwhnbjc` |

Secrets (DB password, service-role key, anon key) live in `.env` (git-ignored).

## Schema

Materialized from the validated TypeORM entities via `node scripts/sync-schema.js`
(50 tables). The hand-written migrations in `src/migrations/` were never runnable
against a fresh DB (snake_case `tenant_id` vs camelCase `"tenantId"`, a missing `app`
schema/functions, and a `search_indexes`/`search_index` typo). The three RLS
migrations are stubbed to no-ops; **RLS still needs a correct reimplementation
against the real `"tenantId"` columns (CLAUDE.md §6.4).**

To (re)provision the schema on a new/empty DB:

```bash
npm run build
node scripts/sync-schema.js          # create tables from entities
DROP=1 node scripts/sync-schema.js   # wipe public tables first, then recreate
```

## Outstanding follow-ups
- Reimplement RLS + tenant triggers against `"tenantId"` (uuid).
- `SUPABASE_JWT_SECRET` in `.env` is still a placeholder — set it from the dashboard
  (Project Settings → API → JWT Secret) if you validate Supabase-issued user JWTs.
- `packages/config-packs/ae/banking.json` fails the config-pack naming validator
  ("must be country/vertical") — loader skips it.
- Elasticsearch is optional and not configured (connection warning is harmless).
