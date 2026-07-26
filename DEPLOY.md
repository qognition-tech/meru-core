# Deploying Meru Core (`api.meru.com`)

Meru Core is a **NestJS** server with **BullMQ background workers** (`@nestjs/bull`)
and **cron jobs** (`@nestjs/schedule`), plus a persistent TypeORM connection pool to
Supabase Postgres. It must run as a **long-lived process**, not as serverless
functions.

> ⚠️ **Vercel caveat:** Vercel runs the API as serverless functions that freeze
> between requests. HTTP endpoints work, but **BullMQ queue processing, scheduled
> crons, and the config-pack loader's background work will not run reliably.** Use
> Vercel only for a quick API demo. For a correct deployment use Render or Fly.io.

## Supabase connection

The app talks to Supabase two ways:
1. **Postgres** via TypeORM — uses the **transaction pooler** host
   (`aws-0-<region>.pooler.supabase.com:6543`, user `postgres.<ref>`). Direct port
   5432 is blocked on this project. SSL is enabled (`rejectUnauthorized: false`).
2. **Supabase API** (`@supabase/supabase-js`) via `SUPABASE_URL` +
   `SUPABASE_SERVICE_ROLE_KEY` for auth/storage helpers.

Required env vars are listed in `.env.example`. Secrets currently live in `.env`
(git-ignored).

## Run the database migrations (once)

```bash
npm run migration:run
```

This creates all tables + RLS policies. Safe to re-run (TypeORM tracks applied
migrations).

> If the schema was created outside TypeORM (e.g. by `scripts/sync-schema.js`),
> the `migrations` table will be empty and TypeORM will try to replay
> `InitialSchema`, failing with `42P07 relation already exists`. Baseline it once:
> ```bash
> node scripts/baseline-migrations.js --apply --through 1744010000000
> ```

---

## Tenant isolation: the two-role setup (REQUIRED)

**Row-level security is silently inert for any Postgres role holding
`BYPASSRLS`, and that is the default for managed-Postgres owner accounts** —
Neon's `neondb_owner`, Supabase's `postgres`, RDS masters. Connect the app as the
owner and every tenant policy in the database is decoration: `\d+` shows the
policies, `relrowsecurity` reads true, and nothing is filtered.

So there are two connections:

| Env var             | Role           | Used for                        |
|---------------------|----------------|---------------------------------|
| `DATABASE_URL`      | owner          | migrations / DDL only           |
| `DATABASE_APP_URL`  | `meru_app`     | **application runtime**         |

`meru_app` is created by the `AddTenantRowLevelSecurity` migration
(`NOBYPASSRLS`, no login). Give it credentials:

```bash
node scripts/provision-rls-role.js --write-env   # writes DATABASE_APP_URL to .env
```

Then prove isolation actually holds before shipping:

```bash
npm run rls:verify
```

It connects as `meru_app` and tries to read, insert, update and delete across
tenant boundaries on real tables. It exits non-zero on any failure, so it is
safe to use as a deploy gate. Expected output ends with
`Tenant isolation verified.`

If `DATABASE_APP_URL` is unset the app still boots (falling back to
`DATABASE_URL`) but logs a loud error, and **refuses to start in
`NODE_ENV=production`** — see `assertRlsEnforceable` in
`src/core/tenancy/rls.datasource.ts`.

---

## Option A — Render (recommended, persistent)

A `render.yaml` Blueprint is included.

1. Push this repo to GitHub (already on GitHub).
2. Render Dashboard → **New → Blueprint** → select the repo.
3. Render reads `render.yaml`, builds the Dockerfile, and prompts for the
   `sync:false` secrets (`DATABASE_HOST`, `DATABASE_PASSWORD`, `SUPABASE_*`, etc.).
   Paste the values from `.env`.
4. Deploy. Health check: `GET /api/v1/health`.

CLI alternative: `render login` then `render blueprint launch`.

## Option B — Fly.io (persistent)

A `fly.toml` is included.

```bash
fly auth login
fly launch --no-deploy           # creates the app from fly.toml
fly secrets set \
  DATABASE_HOST="..." DATABASE_USERNAME="..." DATABASE_PASSWORD="..." \
  SUPABASE_URL="..." SUPABASE_SERVICE_ROLE_KEY="..." SUPABASE_ANON_KEY="..." \
  SUPABASE_JWT_SECRET="..." JWT_SECRET="..." DOCUMENT_ENCRYPTION_KEY="..."
fly deploy
```

## Option C — Vercel (demo only, API-only)

A `vercel.json` + `api/index.ts` serverless wrapper is included. Background
workers/cron will NOT run.

```bash
vercel link
vercel env add DATABASE_HOST   # repeat for each var in .env.example
vercel --prod
```

## Option D — Docker anywhere

```bash
docker build -t meru-core .
docker run --env-file .env -p 8000:8000 meru-core
```

---

## Health

`GET /api/v1/health` → `{ status, database: "up"|"down", uptime, ... }`.
Swagger UI: `GET /api`.
