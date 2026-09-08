# Meru-Core Copilot Instructions

Rewritten 2026-09-05 to match the running system. The previous version described a stack this
repo does not run — Docker/RDS/AWS Secrets Manager for infra, `tenant_id`/`vertical`/`environment`
columns, `docker-compose.dev.yml` for local dev. None of that exists here. **`CLAUDE.md` and
`AGENTS.md` in this repo are the authoritative docs; this file is a short-form pointer to them
for Copilot, not a second source of truth.**

## Architecture

NestJS 11 REST API, multi-tenant, Postgres (Neon) with Row-Level Security for tenant isolation.
14 horizontal modules (IAM, CRM, Search, AI, Workflow, Forms, Tasks, Communications, Documents,
Billing, Analytics, Audit, Integrations, plus Tenant Config) cover ~80% of regulatory plumbing;
the remaining ~20% is injected per vertical as JSON config packs (`packages/config-packs/`).
See `CLAUDE.md` §1–§4 for the full model.

## Tenancy — the column is `"tenantId"`, camelCase and quoted, not `tenant_id`

There is no `vertical` or `environment` column on tenant-scoped tables. The app connects as
**`meru_app`**, a role **without** `BYPASSRLS`; every tenant-scoped table carries **`ENABLE`
and `FORCE ROW LEVEL SECURITY`** (migration `AddTenantRowLevelSecurity`, not
`AddRowLevelSecurity` — that earlier migration is superseded). Policies read
`current_setting('app.current_tenant_id')`, set per-request on the pooled connection by
`TenantAlsMiddleware` → `TenantBindingInterceptor` → `applyRlsToDataSource`
(`src/core/tenancy/`). Boot refuses to start under `NODE_ENV=production` if the runtime role
holds `BYPASSRLS` — RLS is inert for an owner role, and Neon hands you `BYPASSRLS` by default
on `neondb_owner`. `DATABASE_URL` (owner) is for migrations only; `DATABASE_APP_URL`
(`meru_app`) is the runtime connection. **RLS isolates tenants, not users inside a tenant** —
every resource a `client`-role token can reach needs its own scoping check in the service
layer; see `CLAUDE.md` §5.1.

## Key patterns

- **Universal Entity Manager.** There is no `/cases`, no `/leads` — everything is
  `/crm/entities?type=…`. Vertical fields go in `verticalAttributes` (deep-merged on `PATCH`,
  never replaced); `status`, `dueDate`, `assignedTo` are promoted indexed columns.
- **Guards.** `AuthGuard('jwt')` + `PolicyGuard` (`src/iam/guards/policy.guard.ts`), driven by
  `@Roles()`. **A route with no `@Roles()` decorator has no role check at all** —
  `PolicyGuard` only enforces when the decorator is present. Confirm one exists before
  assuming a controller is protected.
- **Config packs, not vertical code.** Visa subclasses, document checklists, fee schedules,
  workflows, navigation — all JSON, resolved by a generic evaluator that has no idea which
  vertical it serves. Writing vertical vocabulary into `src/` is the one mistake this
  architecture exists to prevent — see `CLAUDE.md` §5.5.
- **Entitlements.** `src/iam/entitlements/`: `ModuleCode`, `@RequiresModule`,
  `ModuleEntitlementGuard` → HTTP 402. Applied to GRC routes only, deliberately never
  retrofitted onto a route ImmiStack already calls — entitlement grants are **data**, frozen
  into `tenant.settings.modules` at provisioning, so rewriting a code silently rewrites live
  grants in production.
- **Storage.** `StorageDriverRegistry` (`src/storage/`) resolves S3 or Supabase per tenant,
  registering only a driver whose credentials are present. No module outside `src/storage/`
  imports an object-store SDK directly.

## Developer workflows

- **Local dev:** no `docker-compose` — this repo has no local Postgres/Redis container setup.
  Point `DATABASE_URL`/`DATABASE_APP_URL` at a real Neon database (see `CLAUDE.md` §8.3) and
  run `npm run start:dev`.
- **Migrations:** `npm run migration:run` against `DATABASE_URL` (owner). Every migration must
  be registered in `src/config/migrations.ts`'s `ALL_MIGRATIONS` array — the deployed
  `/jobs/migrate` route uses this array, **not** a filesystem glob, and a migration that exists
  on disk but is missing from the array does not exist as far as production is concerned. This
  exact bug has recurred four times in this file; check the array, not just the `migrations/`
  directory.
- **Testing:** `npm test` (unit), `npm run test:e2e`. **Unit tests construct services directly
  and cannot catch a module-wiring fault** — this repo has shipped a commit that passed every
  unit test and did not boot. Run the compiled app and grep for `Nest application successfully
  started`.
- **Build/deploy:** `npm run build && npm run check:cjs && npm test && npm run rls:verify`,
  then `vercel deploy --prod --yes --scope qognitionagencys-projects`. **There is no Dockerfile
  path to production and no CI/CD pipeline in this repo** — deploys are Vercel CLI only, and
  pushing to GitHub does nothing. `check:cjs` exists because Vercel's CommonJS loader cannot
  `require()` an ES module anywhere in the graph; it has caught two otherwise-invisible
  failures (`uuid`, `otplib` v13).
- **Linting/formatting:** `npm run lint` (ESLint), `npm run format` (Prettier) on `src/**/*.ts`.

## Conventions

- **Naming:** controllers end in `.controller.ts`, services in `.service.ts`, entities live in
  an `entities/` subfolder.
- **API prefix:** every route is under `/api/v1` (`src/main.ts`).
- **Config:** environment variables validated via Joi in `src/config/configuration.ts`.
  **Secrets live on Vercel env only** — there is no AWS Secrets Manager integration; do not
  invent one.
- **Security:** Helmet for headers; rate limiting exists in `src/main.ts` but is **not** ported
  into `api/index.js`, the file Vercel actually serves for every route — an interim in-memory
  limiter was added there 2026-09-05, durable fix is Upstash (ADR 0004). JWT auth via Passport.
  Documents encrypted with `DOCUMENT_ENCRYPTION_KEY`.

## Integration points

- **AI:** the `openai` SDK directly against any OpenAI-compatible endpoint — `langchain` is
  not a dependency. Golden-rule default is DeepSeek (ADR 0003, not yet wired); the platform
  fallback today reads only `OPENAI_API_KEY`.
- **Storage:** S3 or Supabase per tenant (see above) — not a hardcoded AWS S3 client.
- **Cross-module:** `@nestjs/event-emitter` for cross-module events (e.g. a document upload can
  trigger AI embedding); `src/orchestration/` coordinates AI + Search + Documents for agent runs.
- **Monitoring:** there is no Grafana/Prometheus wired into this deployment. `grafana/` and
  `prometheus.yml` at the repo root are legacy artefacts from an earlier bare-metal plan — see
  `infra/README.md`. Logs are NestJS's built-in logger only; there is no APM today.
