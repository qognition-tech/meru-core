import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

// Swagger lives here rather than inline in main.ts because there are TWO
// bootstrap paths and they must not drift: src/main.ts (long-lived server) and
// api/index.js (Vercel serverless, which requires the compiled dist/src/swagger).
// It previously lived only in main.ts, so the deployed API served no docs at all.
//
// SwaggerModule.setup() is NOT affected by setGlobalPrefix, so the UI is at
// `/api` and the raw OpenAPI document at `/api-json`.
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Meru Core API — RegOS Engine')
    .setDescription(
      [
        '**Meru Core** — The Regulated Operating System (RegOS) Engine.',
        '',
        'Multi-vertical, multi-tenant platform powering:',
        '- **ImmiStack** — Immigration case management',
        '- **GovernanceX** — Banking GRC & compliance',
        '',
        'All routes are served under the `/api/v1` prefix.',
        '',
        '### Authentication',
        'Call `POST /api/v1/auth/login`, then paste the returned `access_token`',
        'into **Authorize → JWT-auth**. There is no API-key authentication:',
        'nothing validates an `x-api-key` header, so do not send one.',
        '',
        '### Common Headers',
        '| Header | Description |',
        '|---|---|',
        '| `X-Request-ID` | Unique request identifier for tracing |',
        '| `X-Tenant-ID` | Tenant UUID for multi-tenant context |',
        '| `X-Vertical` | Vertical context: `immigration`, `grc` |',
        '| `X-Environment` | Environment: `development`, `staging`, `production` |',
        '',
        '### Response Envelope',
        'All responses follow: `{ data, meta: { requestId, timestamp, version }, error }`',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addServer('https://meru-core.vercel.app', 'Production')
    .addServer('http://localhost:8000', 'Local development')
    // ── Tags ────────────────────────────────────────────────────────────────
    // Every tag a controller actually emits must be declared here, or Swagger
    // UI renders it as an undescribed group at the bottom. The previous list
    // declared 11 tags, 3 of which no controller used (`iam`, `workflow` and a
    // `config` that the config-pack controller never applied), while 14 real
    // ones went undeclared.
    .addTag('app', 'Application health & status')
    .addTag('health', 'Liveness & readiness probes')
    .addTag('auth', 'IAM — login, registration, sessions, SSO')
    .addTag('tenant', 'Tenant settings')
    .addTag('tenant-provisioning', 'Tenant signup, upgrades and stats')
    .addTag('config', 'Configuration Packs — vertical/country JSON packs')
    .addTag('crm', 'Universal Entity Manager — people, cases, assets, orgs')
    .addTag('documents', 'Document Hub — upload, OCR, versioning')
    .addTag('Storage', 'S3 storage layer — files, versions, multipart uploads')
    .addTag('workflows', 'Workflow Engine — BPMN-like state machines')
    .addTag('forms', 'Dynamic Form Builder')
    .addTag('tasks', 'Task & Activity Manager')
    .addTag('Notifications', 'Communication Hub — templates, preferences')
    .addTag('ai', 'AI Gateway — doc-intel, screening, radar, vessel engines')
    .addTag('orchestration', 'Cross-module orchestration & agents')
    .addTag('search', 'Universal Search — BM25 + vector hybrid')
    .addTag('Elasticsearch', 'Elasticsearch index & document management')
    .addTag('analytics', 'Analytics — dashboards, reports, widgets')
    .addTag('billing', 'Billing — subscriptions, invoices, usage')
    .addTag('audit', 'Audit & Compliance Logger')
    .addTag('integrations', 'Integration Hub — government API adapters')
    .addTag('Queue', 'Background job queue (Postgres-backed)')
    .addTag('jobs', 'Scheduled job entrypoints (cron-invoked)')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter the access token returned by POST /auth/login',
        in: 'header',
      },
      'JWT-auth',
    )
    // No `x-api-key` scheme. One was advertised here for as long as the file
    // has existed, and nothing ever enforced it: there is no passport strategy,
    // no guard and no route that reads the header. A documented credential
    // that the server ignores is worse than none — an integrator builds
    // against it and their calls 401 on the JWT guard with no explanation. See
    // `src/iam/entities/api-key.entity.ts` for the dead storage side.
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('api', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });
}
