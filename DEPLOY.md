# Deploying Meru Core

## Currently deployed

**https://meru-core.vercel.app** — Vercel, region `sin1`, project `meru-core`.

| | |
|---|---|
| API | `https://meru-core.vercel.app/api/v1` |
| Swagger UI | `https://meru-core.vercel.app/api` |
| OpenAPI JSON | `https://meru-core.vercel.app/api-json` |
| Health | `https://meru-core.vercel.app/api/v1/health` |
| Database | Neon Postgres, `ap-southeast-1`, connected as `meru_app` |

Deploys are **CLI-driven** (`vercel --prod`), not git-triggered — the project has
no git integration attached, so pushing to GitHub does not deploy. Note also that
`origin` points at `qognition-tech/meru-core`, which the current gh account cannot
push to; `fork` (`qognitionagency/meru-core`) is writable.

Meru Core is a NestJS server with cron jobs (`@nestjs/schedule`) and a
Postgres-backed job queue, plus a TypeORM pool to Neon. Serverless suits the HTTP
surface fine, but scheduled work needs the arrangement described under
[Scheduled jobs](#scheduled-jobs-on-serverless) below. Render and Fly (options B
and C) remain available if you later want a long-lived process instead.

### Before every deploy

```bash
npm run build        # must be clean
npm run check:cjs    # no ESM-only packages in the require graph — see below
npm run rls:verify   # tenant isolation still holds
BASE_URL=https://meru-core.vercel.app npm run smoke:routes
```

> **`npm run check:cjs` is not optional.** Vercel runs the function through its
> own CommonJS loader, which — unlike Node 22+ — cannot `require()` an ES module
> at all. A single ESM-only package anywhere in the require graph returns
> `FUNCTION_INVOCATION_FAILED` on *every* request, and it works perfectly on
> local Node, so nothing else catches it. This has bitten twice: `uuid`, then
> `otplib` v13 by way of `@scure/base`.

### Serverless constraints worth knowing

- **The filesystem is read-only outside `/tmp`.** Anything that writes at module
  init kills bootstrap before a route is registered — that is why uploads use
  `memoryStorage()` rather than a `dest` directory.
- **Static assets are not traced into the bundle.** Files that are read by path
  rather than `require`d must be listed in `vercel.json` → `functions.includeFiles`.
  Both `packages/config-packs/**` and `node_modules/swagger-ui-dist/**` are there
  for this reason; drop either one and config packs stop seeding or the docs page
  renders blank.

## Database connection

Postgres via TypeORM against **Neon**, over the pooled connection string Neon
issues (`postgresql://<user>:<pw>@<host>.neon.tech/<db>?sslmode=require`). SSL is
enabled with `rejectUnauthorized: false` because the pooler presents a cert that
isn't in the local trust store.

Two connection strings are required — see the two-role setup below. Every variable
is documented in `.env.example`; secrets live in `.env` (git-ignored). Background
on the schema and its history is in [DATABASE.md](DATABASE.md).

Redis is optional — the job queue is Postgres-backed (`queue_jobs`), so `REDIS_HOST`
only selects the cache store and defaults to in-memory when unset.

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

## Scheduled jobs on serverless

`@nestjs/schedule`'s `@Cron` decorators never fire on Vercel, and the queue
processor's polling loop is disabled under `VERCEL` (an infinite loop would just
burn the invocation). All nine scheduled jobs are therefore also HTTP endpoints
under `/api/v1/jobs`, guarded by `CronSecretGuard`, which fails closed when
`CRON_SECRET` is unset. They accept **GET as well as POST** because Vercel Cron
only issues GET.

| Route | Runs |
|---|---|
| `/jobs/tick?scope=fast` | queue-drain, scheduled-jobs, recurring-tasks, scheduled-notifications, sla-watchdog, scheduled-reports |
| `/jobs/tick?scope=daily` | daily-billing, regulatory-radar, audit-archive, digest-emails |
| `/jobs/<name>` | any single job, by name |

`/jobs/tick` is cadence-aware and idempotent — safe to call at any frequency,
since each job only runs once its own interval has elapsed. Dispatch stops after
45s and reports the remainder as `deferred`, so a slow job cannot exceed the
function timeout (`regulatory-radar` alone takes ~34s).

**Hobby plan.** Vercel's Hobby tier allows two cron jobs, firing once per day —
which cannot serve a queue that wants draining every minute. `vercel.json` spends
both slots on `scope=daily` (02:00) and `scope=fast` (03:00, a backstop). The
minute-level work needs a free external scheduler:

```
URL     https://meru-core.vercel.app/api/v1/jobs/tick?scope=fast
Method  GET
Header  Authorization: Bearer <CRON_SECRET>
Every   1–5 minutes
```

[cron-job.org](https://cron-job.org) covers this on its free tier with
1-minute granularity and custom headers. A GitHub Actions `schedule` works too,
but a private repo's 2,000 free minutes/month cap it at roughly one call per
30 minutes. Upgrading Vercel to Pro removes the need for either — point a
1-minute cron at the same URL and delete the external job.

Until an external scheduler is attached, queue jobs, recurring tasks and
scheduled notifications only run twice a day.

## Option A — Render (recommended, persistent)

A `render.yaml` Blueprint is included.

1. Push this repo to GitHub (already on GitHub).
2. Render Dashboard → **New → Blueprint** → select the repo.
3. Render reads `render.yaml`, builds the Dockerfile, and prompts for the
   `sync:false` secrets (`DATABASE_URL`, `DATABASE_APP_URL`, `JWT_SECRET`, etc.).
   Paste the values from `.env`.
4. Deploy. Health check: `GET /api/v1/health`.

CLI alternative: `render login` then `render blueprint launch`.

## Option B — Fly.io (persistent)

A `fly.toml` is included.

```bash
fly auth login
fly launch --no-deploy           # creates the app from fly.toml
fly secrets set \
  DATABASE_URL="..." DATABASE_APP_URL="..." \
  JWT_SECRET="..." CRON_SECRET="..." DOCUMENT_ENCRYPTION_KEY="..." \
  REDIS_HOST="..." REDIS_PORT="6379"
fly deploy
```

## Option C — Vercel (the current deployment)

`vercel.json` + the `api/index.js` wrapper, which loads the compiled `dist/`
because Vercel bundles `api/` with esbuild and esbuild drops the
`emitDecoratorMetadata` NestJS DI depends on.

```bash
vercel link
vercel env add DATABASE_APP_URL   # repeat for each var in .env.example
vercel --prod
```

`api/index.js` mirrors the middleware stack in `src/main.ts` and shares Swagger
via `src/swagger.ts` so the two cannot drift. Two deliberate differences:
rate limiting is omitted (an in-memory store is per-lambda and therefore
meaningless), and there is no `app.listen()`.

## Option D — Docker anywhere

```bash
docker build -t meru-core .
docker run --env-file .env -p 8000:8000 meru-core
```

---

## Health

`GET /api/v1/health` → `{ status, database: "up"|"down", uptime, ... }`.
Swagger UI: `GET /api`.

---

## Front-end wiring

The three portals in the `meru-core-fe` repo read **`NEXT_PUBLIC_MERU_API_URL`**
(note: not `NEXT_PUBLIC_API_URL`), and the value **includes the `/api/v1`
prefix** — call sites use paths relative to it.

| Project | Origin | Env |
|---|---|---|
| immistack | https://www.immistack.com | `NEXT_PUBLIC_MERU_API_URL=https://meru-core.vercel.app/api/v1`, `NEXT_PUBLIC_MOCK_MODE=false` |
| governancex | https://governancex-three.vercel.app | same |
| meru-dashboard | https://meru-dashboard.vercel.app | same |

These are `NEXT_PUBLIC_*`, so they are inlined at build time — changing one
requires a redeploy, not just an env update. Mock mode also auto-disables for any
non-localhost URL.

Each origin must appear in the API's `CORS_ALLOWED_ORIGINS`. The allowlist is
explicit; `origin: true` is never used alongside `credentials: true`, since that
reflects any origin and defeats the point.
