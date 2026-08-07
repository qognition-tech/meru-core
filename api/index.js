// Vercel serverless entrypoint for Meru Core.
//
// This is deliberately plain JS that loads the ALREADY-COMPILED output in
// dist/. Vercel bundles files under api/ with esbuild, and esbuild does not
// support `emitDecoratorMetadata` — so compiling the NestJS source here would
// strip the metadata NestJS DI depends on and every provider would fail to
// resolve. `nest build` (tsc) emits that metadata, so we consume its output.
// This is why vercel.json runs `npm run build` before the function is bundled.
//
// The middleware/pipe/filter/interceptor stack below mirrors src/main.ts. The
// ResponseEnvelopeInterceptor is load-bearing: every frontend unwraps
// `{ data, meta, error }`, so dropping it here silently breaks all three apps.
//
// NOT running in this mode: BullMQ workers (gated off via VERCEL in
// JobProcessor) and @nestjs/schedule cron. Cron is driven by Vercel Cron
// hitting /api/v1/jobs/* instead — see vercel.json.
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { ExpressAdapter } = require('@nestjs/platform-express');
const express = require('express');
const helmet = require('helmet');
const { randomUUID } = require('node:crypto');

const { AppModule } = require('../dist/src/app.module');
const {
  AllExceptionsFilter,
} = require('../dist/src/core/filters/http-exception.filter');
const {
  ResponseEnvelopeInterceptor,
} = require('../dist/src/core/interceptors/response-envelope.interceptor');
const { setupSwagger } = require('../dist/src/swagger');

const server = express();
let ready = null;

function corsOrigins() {
  return process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3002',
      ];
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), {
    logger: ['error', 'warn', 'log'],
    // Stripe signs the exact bytes; a re-serialized body never verifies.
    // src/main.ts sets this too — the two bootstrap paths must not drift, and
    // this one is what actually runs in production.
    rawBody: true,
  });

  // Explicit allowlist. Never `origin: true` alongside `credentials: true` —
  // that reflects any origin and defeats the point.
  app.enableCors({
    origin: corsOrigins(),
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
    maxAge: 86400,
  });

  // The envelope interceptor reads this back out.
  app.use((req, _res, next) => {
    req.headers['x-request-id'] = req.headers['x-request-id'] || randomUUID();
    next();
  });

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  // Rate limiting is deliberately omitted: express-rate-limit's in-memory store
  // is per-lambda, so it provides no real limit across instances. Use the
  // platform WAF or a shared store (Upstash/Vercel KV) instead.

  app.setGlobalPrefix('api/v1');

  // Swagger UI at /api, raw OpenAPI document at /api-json. Shared with
  // src/main.ts via src/swagger.ts so the two bootstrap paths cannot drift —
  // this entrypoint previously omitted Swagger entirely, so the deployed API
  // served no docs at all.
  setupSwagger(app);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());

  await app.init();
}

module.exports = async function handler(req, res) {
  // A rejected bootstrap is cached in `ready`, so one bad boot makes every
  // subsequent request fail with an opaque FUNCTION_INVOCATION_FAILED and no
  // usable log line — which is exactly how a config-validation error cost
  // hours of production downtime. Log the real cause, answer with it, and
  // clear the cache so the next invocation retries rather than being
  // permanently poisoned by a transient failure.
  try {
    if (!ready) ready = bootstrap();
    await ready;
  } catch (err) {
    ready = null;
    const detail = err && err.stack ? err.stack : String(err);
    console.error('[bootstrap-failed]', detail);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        data: null,
        error: {
          code: 'MER-SRV-0000',
          message: 'Application failed to start',
          detail: String(detail).slice(0, 2000),
        },
      }),
    );
    return;
  }
  server(req, res);
};
