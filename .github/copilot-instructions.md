# Meru-Core Copilot Instructions

## Architecture Overview
Meru-Core is a multi-tenant NestJS SaaS platform with shared PostgreSQL database using Row-Level Security (RLS) for isolation. Key components include:
- **Modules**: IAM (auth/tenants), CRM (universal entities), AI (LLM integration), Documents (file storage), Search (semantic search), Orchestration (cross-module coordination)
- **Data Flow**: TenantContextMiddleware extracts vertical/env from domain, sets `app.current_tenant_id` for RLS policies
- **Entities**: All tables include `tenant_id`, `vertical`, `environment` columns for isolation (see `src/migrations/1743860000000-AddRowLevelSecurity.ts`)

## Key Patterns
- **RLS Implementation**: Policies use `current_setting('app.current_tenant_id')` for tenant isolation (e.g., `CREATE POLICY tenant_isolation_users ON users FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid)`)
- **Module Structure**: Each module (e.g., `src/iam/iam.module.ts`) imports TypeOrmModule.forFeature with its entities, exports services for cross-module use
- **Guards**: Use `PolicyGuard` from `src/iam/guards/policy.guard.ts` for RBAC, combined with JWT auth via `JwtStrategy`
- **Entities**: Follow TypeORM conventions with decorators; universal entities in CRM support dynamic schemas (see `src/crm/entities/universal-entity.entity.ts`)
- **Event-Driven**: Use `@nestjs/event-emitter` for cross-module events (e.g., document upload triggers AI embedding)

## Developer Workflows
- **Local Development**: Run `docker-compose -f docker-compose.dev.yml up` to start Postgres/Redis, then `npm run start:dev` for hot-reload
- **Database**: Use `pnpm run migration:run` for TypeORM migrations; seed with `node scripts/setup-db.js` or `node scripts/check-db.js` for health
- **Testing**: `npm run test:e2e` for integration tests; debug with `npm run test:debug`
- **Build/Deploy**: `npm run build` produces dist/, containerized via `Dockerfile`; CI/CD in GitHub Actions (not shown)
- **Linting/Formatting**: `npm run lint` (ESLint) and `npm run format` (Prettier) on `src/**/*.ts`

## Conventions
- **Naming**: Controllers end in `.controller.ts`, services in `.service.ts`; entities in `entities/` subfolder
- **API Prefix**: All routes prefixed with `api/v1` (set in `src/main.ts`)
- **Config**: Environment variables validated via Joi in `src/config/configuration.ts`; secrets loaded from AWS Secrets Manager
- **Verticals**: Code supports multiple verticals (core, immigration, grc) via `VERTICAL` env var; policies enforce vertical isolation
- **Security**: Helmet for headers, rate limiting (100 req/15min), JWT auth with Passport; documents encrypted with `DOCUMENT_ENCRYPTION_KEY`

## Integration Points
- **External APIs**: OpenAI/LangChain for AI (see `src/ai/ai.service.ts`), AWS S3 for storage, RDS for DB
- **Cross-Component**: Orchestration service coordinates AI + Search + Documents; events emitted on entity changes
- **Monitoring**: Grafana/Prometheus setup in `grafana/` and `prometheus.yml`; logs via NestJS built-in</content>
<parameter name="filePath">/Users/qognitionagency/Documents/GitHub/meru/meru-core/.github/copilot-instructions.md