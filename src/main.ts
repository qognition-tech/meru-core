import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger';
import { AllExceptionsFilter } from './core/filters/http-exception.filter';
import { ResponseEnvelopeInterceptor } from './core/interceptors/response-envelope.interceptor';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';

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
    req.headers['x-request-id'] = req.headers['x-request-id'] || randomUUID();
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

  // 6. Swagger Documentation — shared with api/index.js (see src/swagger.ts)
  setupSwagger(app);

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
