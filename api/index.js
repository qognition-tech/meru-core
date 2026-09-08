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
const rateLimit = require('express-rate-limit');
const { randomUUID, timingSafeEqual } = require('node:crypto');

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
  // Shared with src/main.ts — see src/common/cors-origins.ts. Env is additive.
  return require('../dist/src/common/cors-origins').corsOrigins();
}

// Required lazily *inside* bootstrap, but referenced here so esbuild still
// sees the paths and bundles dist/ into the function. Without these the
// lazy require would resolve to nothing at runtime.
require.resolve('../dist/src/app.module');
require.resolve('../dist/src/core/filters/http-exception.filter');
require.resolve('../dist/src/core/interceptors/response-envelope.interceptor');
require.resolve('../dist/src/swagger');
require.resolve('../dist/src/common/cors-origins');

/**
 * Vertical-aware rate limiting — mirrors src/main.ts's limiter exactly
 * (same env vars, same key shape, same MER-RATE-0001 envelope), applied as
 * Express middleware before Nest routing so it covers every route including
 * /auth/login, /auth/refresh, /auth/forgot-password and
 * /auth/reset-password. This entrypoint previously omitted it entirely — the
 * comment that used to sit here said "use the platform WAF or a shared store
 * instead", and until now nothing did either, so production auth routes were
 * completely unthrottled. See Anton's security baseline
 * (scratchpad/reports/anton-security-baseline.md #2).
 *
 * HONEST LIMITATION: this is express-rate-limit's default in-memory
 * MemoryStore, same as main.ts. On Vercel each warm lambda instance keeps its
 * own counters, so this bounds abuse against ONE warm instance, not the
 * deployment as a whole — under N concurrently warm instances the effective
 * ceiling is roughly N times these numbers, not a hard limit. That is a real
 * gap, not a hidden one: it is still strictly better than no limiter, which
 * was the state before this change.
 *
 * The durable fix is a shared store. docs/adr/0004-upstash-redis-qstash.md
 * (D1) proposes `@upstash/redis` with atomic INCR/EXPIRE, keyed
 * rl:auth:{ip} / rl:ai:{tenantId} / rl:global:{ip}::{tenantId}, applied in
 * both main.ts and api/index.js. That ADR is Proposed, not merged — do not
 * add the @upstash/redis dependency here until it lands.
 * TODO(ADR-0004): swap this in-memory limiter for the Upstash-backed one once
 * docs/adr/0004-upstash-redis-qstash.md D1 is approved and
 * UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are provisioned (verify
 * with `vercel env ls`, not `env pull` — workspace CLAUDE.md §12).
 * [UNVERIFIED: whether Express `trust proxy` is correctly set for Vercel's
 * sin1 region — ADR 0004 §4 flags the same gap for `req.ip`-keyed limits.]
 *
 * Factored out (rather than inlined in `bootstrap()`) so a spec can mount it
 * on a bare Express app and assert the 429/allow behaviour without booting
 * Nest — `bootstrap()` needs a live Postgres connection and can't run in a
 * unit/e2e test here.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {[import('express').RequestHandler, import('express').RequestHandler]}
 */
function createRateLimiter(env = process.env) {
  const globalMax = parseInt(env.RATE_LIMIT_MAX_GLOBAL || '100', 10);
  const immigrationMax = parseInt(
    env.RATE_LIMIT_MAX_IMMIGRATION || '100',
    10,
  );
  const bankingMax = parseInt(env.RATE_LIMIT_MAX_BANKING || '50', 10);
  const ttlMs = parseInt(env.RATE_LIMIT_TTL_MS || '60000', 10);

  const verticalMiddleware = (req, _res, next) => {
    const vertical = req.headers['x-vertical'] || '';
    const host = req.hostname || '';

    let max = globalMax;
    if (vertical === 'immigration' || host.includes('immistack')) {
      max = immigrationMax;
    } else if (vertical === 'grc' || host.includes('governancex')) {
      max = bankingMax;
    }

    req.rateLimitMax = max;
    next();
  };

  const limiterMiddleware = rateLimit({
    windowMs: ttlMs,
    max: (req) => req.rateLimitMax || globalMax,
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
      // Rate limit key: IP + tenant for multi-tenant fairness — same shape
      // as main.ts, not tenant-only, since an unauthenticated /auth/login
      // caller has no trustworthy tenant yet.
      const tenantId = req.headers['x-tenant-id'] || 'anonymous';
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      return `${ip}::${tenantId}`;
    },
  });

  return [verticalMiddleware, limiterMiddleware];
}

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

  // See `createRateLimiter` above for the full rationale (Anton finding #2,
  // ADR 0004, the in-memory-per-instance caveat). CORS is registered above
  // this, so a preflight OPTIONS is answered and terminated there and never
  // reaches — let alone counts against — this limiter.
  const [rateLimitVerticalMiddleware, rateLimitMiddleware] =
    createRateLimiter();
  app.use(rateLimitVerticalMiddleware);
  app.use(rateLimitMiddleware);

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
 * Reports only whether a variable is SET, UNSET or EMPTY — never its value
 * and never its length. Length was previously leaked here (`set(${v.length})`)
 * and materially narrows a brute-force search for JWT_SECRET /
 * CREDENTIALS_ENCRYPTION_KEY; a boolean is all an incident actually needs.
 *
 * Gated by CRON_SECRET (see `isDiagAuthorized` below) because this cannot run
 * inside Nest/CronSecretGuard — the whole point is to answer when Nest can't
 * even boot — so the same bearer-token contract is re-implemented here by
 * hand against the identical env var. Keep the two in sync if the guard's
 * contract ever changes (`src/jobs/cron-secret.guard.ts`).
 *
 * Pure function of `sourceEnv` (defaults to `process.env`) so a spec can call
 * it directly with a fake env object — no HTTP round trip, no Nest boot.
 */
function diagReport(sourceEnv = process.env) {
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
    const v = sourceEnv[n];
    env[n] = v === undefined ? 'UNSET' : v === '' ? 'EMPTY' : 'set';
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

// Exact paths only — never `req.url.includes('__diag')`, which also matched
// e.g. `/anything__diagnostics` and, more importantly, made the auth check
// below trivial to reason about wrong. Vercel's rewrite
// (`vercel.json`'s `"source": "/(.*)"`) preserves the original request path
// in `req.url`, so both the un-prefixed and `api/v1`-prefixed forms are
// listed defensively even though Nest's global prefix is applied later, past
// this point in the pipeline, and never sees these requests at all.
const DIAG_PATHS = new Set(['/api/__diag', '/api/v1/__diag']);

function diagPathname(url) {
  if (!url) return '';
  const qIdx = url.indexOf('?');
  return qIdx === -1 ? url : url.slice(0, qIdx);
}

/**
 * Mirrors `CronSecretGuard.canActivate` (`src/jobs/cron-secret.guard.ts`)
 * exactly — same header (`Authorization: Bearer <CRON_SECRET>`), same
 * constant-time compare — because this diagnostic runs before Nest exists and
 * so cannot go through the real guard. Fails closed: an unset/blank
 * CRON_SECRET denies the request, it never falls back to serving the report.
 *
 * `expected` defaults to `process.env.CRON_SECRET` but is an explicit
 * parameter so a spec can assert the gate decision directly against a fake
 * secret, with no env mutation and no HTTP round trip.
 */
function isDiagAuthorized(req, expected = process.env.CRON_SECRET) {
  if (!expected || expected.trim().length === 0) return false;

  const header = req.headers && req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return false;
  }

  const provided = header.slice('Bearer '.length);
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function diagNotFound(req, res) {
  res.statusCode = 404;
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      data: null,
      meta: {
        requestId: req.headers['x-request-id'] || randomUUID(),
        timestamp: new Date().toISOString(),
        version: 'v1',
      },
      error: {
        code: 'MER-RES-0001',
        message: 'Not found',
        helpUrl: 'https://docs.meru.dev/errors#merres0001',
      },
    }),
  );
}

module.exports = async function handler(req, res) {
  const diagPath = diagPathname(req.url);
  if (DIAG_PATHS.has(diagPath)) {
    // Anton's security baseline (scratchpad/reports/anton-security-baseline.md
    // #1): this previously answered ANY request whose URL merely contained
    // "__diag" with unauthenticated secret lengths, and `?db=1`/`?boot=1`
    // opened real DB connections and a full bootstrap for anyone. Log every
    // attempt, authorized or not, so an unauthorized probe is at least
    // visible in the function logs even though the caller now just gets 404.
    const authorized = isDiagAuthorized(req);
    console.warn('[__diag] access attempt', {
      path: diagPath,
      method: req.method,
      ip: (req.socket && req.socket.remoteAddress) || 'unknown',
      authorized,
    });

    if (!authorized) {
      diagNotFound(req, res);
      return;
    }

    const payload = diagReport();

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
  // hours of production downtime. Log the real cause server-side and clear
  // the cache so the next invocation retries rather than being permanently
  // poisoned by a transient failure.
  //
  // The caller gets a generic envelope only — NOT the stack trace. This route
  // is unauthenticated by construction (bootstrap has not run, so no guard
  // exists yet), and the detail can contain file paths, module names and
  // fragments of a connection string from the underlying driver's error.
  // Anyone who can trigger a bad boot (a misconfigured env var, an
  // unreachable DB) would otherwise get that for free. Full detail stays in
  // `console.error` for whoever is watching the function logs.
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
        meta: {
          requestId: req.headers['x-request-id'] || randomUUID(),
          timestamp: new Date().toISOString(),
          version: 'v1',
        },
        error: {
          // MeruErrorCode.SERVER_UNAVAILABLE (src/common/types.ts) — the
          // service did not come up, not an internal error mid-request.
          // 'MER-SRV-0000' does not exist in the code list; do not reuse it.
          code: 'MER-SRV-0002',
          message: 'Service temporarily unavailable',
          helpUrl: 'https://docs.meru.dev/errors#mersrv0002',
        },
      }),
    );
    return;
  }
  server(req, res);
};

// Test-only surface, attached to the exported handler function rather than
// changing the module's shape (Vercel just calls it; extra properties on a
// function are inert to that). Lets a spec exercise the diag gate and the
// rate limiter directly — without going through a real request that would
// fall into `bootstrap()`, and without a live Postgres connection.
module.exports.diagPathname = diagPathname;
module.exports.isDiagAuthorized = isDiagAuthorized;
module.exports.diagReport = diagReport;
module.exports.DIAG_PATHS = DIAG_PATHS;
module.exports.createRateLimiter = createRateLimiter;
