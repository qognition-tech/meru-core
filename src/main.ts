import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './core/filters/http-exception.filter';
import { ResponseEnvelopeInterceptor } from './core/interceptors/response-envelope.interceptor';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  // Determine CORS origins from env
  const corsOrigins = process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : [
        'http://localhost:3000', // meru-core itself
        'http://localhost:3001', // ImmiStack app
        'http://localhost:3002', // GovernanceX app
        'https://app.immistack.com',
        'https://app.governancex.com',
        'https://api.immistack.com',
        'https://api.governancex.com',
      ];

  // 1. CORS — Allow ImmiStack + GovernanceX origins (+ staging/dev variants)
  app.enableCors({
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-ID',
      'X-Tenant-ID',
      'X-Vertical',
      'X-Environment',
    ],
    credentials: true,
    maxAge: 86400, // 24 hours preflight cache
  });
  logger.log(`CORS enabled for origins: ${corsOrigins.join(', ')}`);

  // 2. Request ID Middleware — ensures every request has a traceable ID
  app.use((req, _res, next) => {
    req.headers['x-request-id'] = req.headers['x-request-id'] || uuidv4();
    next();
  });

  // 3. Security Headers (Helmet)
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow ImmiStack/GovernanceX to load assets
    }),
  );

  // 4. Vertical-Aware Rate Limiting
  //   - Immigration tenants: higher limit (firm staff processing many cases)
  //   - Banking/GRC tenants: stricter limit (compliance-sensitive, lower concurrency)
  const globalMax = parseInt(process.env.RATE_LIMIT_MAX_GLOBAL || '100', 10);
  const immigrationMax = parseInt(
    process.env.RATE_LIMIT_MAX_IMMIGRATION || '100',
    10,
  );
  const bankingMax = parseInt(process.env.RATE_LIMIT_MAX_BANKING || '50', 10);
  const ttlMs = parseInt(process.env.RATE_LIMIT_TTL_MS || '60000', 10);

  // Global rate limiter — applies before vertical-specific limits
  app.use((req, _res, next) => {
    // Check for vertical context header or subdomain
    const vertical = (req.headers['x-vertical'] as string) || '';
    const host = req.hostname || '';

    let max = globalMax;
    if (vertical === 'immigration' || host.includes('immistack')) {
      max = immigrationMax;
    } else if (vertical === 'grc' || host.includes('governancex')) {
      max = bankingMax;
    }

    // Attach rate limit context for the actual rate limiter
    req.rateLimitMax = max;
    next();
  });

  app.use(
    rateLimit({
      windowMs: ttlMs,
      max: (req) => (req as any).rateLimitMax || globalMax,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        data: null,
        meta: {
          requestId: 'rate-limited',
          timestamp: new Date().toISOString(),
          version: 'v1',
        },
        error: {
          code: 'MER-RATE-0001',
          message: 'Too many requests. Please try again later.',
          helpUrl: 'https://docs.meru.dev/errors#mer-rate-0001',
        },
      },
      keyGenerator: (req) => {
        // Rate limit key: IP + tenant for multi-tenant fairness
        const tenantId = (req.headers['x-tenant-id'] as string) || 'anonymous';
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        return `${ip}::${tenantId}`;
      },
    }),
  );
  logger.log(
    `Rate limiting: global=${globalMax}, immigration=${immigrationMax}, banking=${bankingMax}, ttl=${ttlMs}ms`,
  );

  // 5. Global Prefix
  app.setGlobalPrefix('api/v1');

  // 6. Swagger Documentation
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
    .addServer('http://localhost:3000', 'Development')
    .addServer('https://api.immistack.com', 'ImmiStack Production')
    .addServer('https://api.governancex.com', 'GovernanceX Production')
    .addTag('app', 'Application health & status')
    .addTag('iam', 'Identity & Access Management — auth, tenants, roles')
    .addTag('crm', 'Customer Relationship Management — entities, cases, notes')
    .addTag('documents', 'Document Hub — upload, OCR, storage')
    .addTag('workflow', 'Workflow Engine — BPMN-like task orchestration')
    .addTag('forms', 'Dynamic Form Builder')
    .addTag('ai', 'AI Gateway — doc-intel, screening, comms, decision engines')
    .addTag('analytics', 'Analytics — dashboards, reports')
    .addTag('billing', 'Billing — subscriptions, invoices, usage')
    .addTag('search', 'Universal Search (MeiliSearch)')
    .addTag('config', 'Configuration Packs — vertical/country JSON packs')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter your Supabase JWT token',
        in: 'header',
      },
      'JWT-auth',
    )
    .addApiKey(
      {
        type: 'apiKey',
        name: 'x-api-key',
        in: 'header',
        description: 'API Key for service-to-service authentication',
      },
      'API-Key',
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });

  // 7. Global Validation Pipe (Auto-transform DTOs)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // 8. Global Exception Filter — enforces API Response Envelope on errors
  app.useGlobalFilters(new AllExceptionsFilter());

  // 9. Global Response Interceptor — wraps successful responses in API envelope
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());

  const port = parseInt(process.env.PORT || '3000', 10);
  await app.listen(port);
  logger.log(`Meru Core API running on: http://localhost:${port}`);
  logger.log(`Swagger docs: http://localhost:${port}/api`);
  logger.log(`Vertical: ${process.env.VERTICAL || 'core'}`);
}

bootstrap();
