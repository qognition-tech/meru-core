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

// Deliberately NOT required at module scope. `dist/src/app.module` runs
// ConfigModule's Joi validation at import time, so a bad environment variable
// throws here — before the handler below is even defined, and therefore
// outside any try/catch it could have. The result is
// FUNCTION_INVOCATION_FAILED with no diagnosable log line, which is exactly
// how a single empty env var became hours of unexplained downtime.
//
// Loading them inside bootstrap() puts the throw somewhere the handler can
// catch, log and report.

const server = express();
let ready = null;

/**
 * Node exits the process on an unhandled rejection (default since v15), and
 * TypeORM's connection retry loop can reject outside the promise the
 * bootstrap awaits. The result on Vercel is `exit status: 1` and
 * FUNCTION_INVOCATION_FAILED with the real cause never reaching a log — the
 * exact signature of this outage, which survived four fixes aimed at config
 * and TLS because neither was the problem.
 *
 * Recording it here does not paper over the failure: bootstrap still rejects
 * and the handler still answers 500. It only ensures the reason is written
 * down before the runtime tears the process apart.
 */
let lastFatal = null;
process.on('unhandledRejection', (reason) => {
  lastFatal = reason && reason.stack ? reason.stack : String(reason);
  console.error('[unhandled-rejection]', lastFatal);
});
process.on('uncaughtException', (err) => {
  lastFatal = err && err.stack ? err.stack : String(err);
  console.error('[uncaught-exception]', lastFatal);
});

function corsOrigins() {
  return process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3002',
      ];
}

// Required lazily *inside* bootstrap, but referenced here so esbuild still
// sees the paths and bundles dist/ into the function. Without these the
// lazy require would resolve to nothing at runtime.
require.resolve('../dist/src/app.module');
require.resolve('../dist/src/core/filters/http-exception.filter');
require.resolve('../dist/src/core/interceptors/response-envelope.interceptor');
require.resolve('../dist/src/swagger');

async function bootstrap() {
  const { AppModule } = require('../dist/src/app.module');
  const {
    AllExceptionsFilter,
  } = require('../dist/src/core/filters/http-exception.filter');
  const {
    ResponseEnvelopeInterceptor,
  } = require('../dist/src/core/interceptors/response-envelope.interceptor');
  const { setupSwagger } = require('../dist/src/swagger');

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

/**
 * Pre-boot diagnostic. Answers before Nest is constructed, so it still works
 * when the application cannot start — which is the only time anyone needs it.
 *
 * Reports whether a variable is SET and how long its value is. Never the
 * value: this endpoint is unauthenticated by necessity (auth lives inside the
 * app that isn't booting) and a leaked DATABASE_URL is worse than an outage.
 */
function diagnostics() {
  const names = [
    'NODE_ENV', 'VERTICAL', 'PORT',
    'DATABASE_URL', 'DATABASE_APP_URL',
    'GOVX_DB_URL', 'GOVX_DB_APP_URL',
    'IMMISTACK_DB_URL', 'IMMISTACK_DB_APP_URL',
    'JWT_SECRET', 'CRON_SECRET', 'CREDENTIALS_ENCRYPTION_KEY',
    'CORS_ALLOWED_ORIGINS', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY',
  ];
  const env = {};
  for (const n of names) {
    const v = process.env[n];
    env[n] = v === undefined ? 'UNSET' : v === '' ? 'EMPTY' : `set(${v.length})`;
  }
  let distLoads = 'unknown';
  try {
    require.resolve('../dist/src/app.module');
    distLoads = 'resolvable';
  } catch (e) {
    distLoads = 'MISSING: ' + e.message;
  }
  return { node: process.version, env, distLoads, lastFatal };
}

module.exports = async function handler(req, res) {
  if (req.url && req.url.includes('__diag')) {
    const payload = diagnostics();

    // `?boot=1` attempts the real bootstrap inside THIS invocation and reports
    // whatever it throws. Necessary because every Vercel invocation is a fresh
    // process: the request that crashes and the request that asks about it
    // never share memory, so a fatal recorded on one is invisible to the
    // other. This is the only way to see the failure from outside.
    // `?db=1` opens a raw pg connection with a SHORT timeout and reports the
    // outcome. bootstrap() cannot tell us this: TypeORM retries a failed
    // connection ten times at three-second intervals, which exceeds the
    // function's maxDuration, so the runtime kills the process before
    // anything throws — no stack, no log, just FUNCTION_INVOCATION_FAILED.
    // A bounded probe distinguishes "cannot reach the database" from
    // "reached it and something else broke".
    if (req.url.includes('db=1')) {
      const { Client } = require('pg');
      const targets = {
        DATABASE_APP_URL: process.env.DATABASE_APP_URL,
        DATABASE_URL: process.env.DATABASE_URL,
      };
      payload.db = {};
      for (const [name, raw] of Object.entries(targets)) {
        if (!raw) { payload.db[name] = 'UNSET'; continue; }
        const started = Date.now();
        const client = new Client({
          connectionString: raw,
          ssl: { rejectUnauthorized: false },
          connectionTimeoutMillis: 8000,
          query_timeout: 8000,
        });
        try {
          await client.connect();
          const r = await client.query(
            'SELECT current_user AS u, rolbypassrls FROM pg_roles WHERE rolname = current_user',
          );
          payload.db[name] = {
            ok: true,
            ms: Date.now() - started,
            user: r.rows[0] && r.rows[0].u,
            bypassrls: r.rows[0] && r.rows[0].rolbypassrls,
          };
        } catch (e) {
          payload.db[name] = { ok: false, ms: Date.now() - started, error: String(e.message).slice(0, 300) };
        } finally {
          try { await client.end(); } catch (_) {}
        }
      }
    }

    if (req.url.includes('boot=1')) {
      try {
        await bootstrap();
        payload.bootResult = 'BOOT OK';
      } catch (err) {
        payload.bootResult =
          'BOOT FAILED: ' + (err && err.stack ? err.stack : String(err));
      }
      ready = null; // never cache a probe's outcome for real traffic
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload, null, 2));
    return;
  }

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
    const detail = (err && err.stack ? err.stack : String(err)) +
      (lastFatal ? `\n--- earlier fatal ---\n${lastFatal}` : '');
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
