import http from 'node:http';
import express from 'express';
import request from 'supertest';

// Exercises api/index.js's `createRateLimiter` factory in isolation, mounted
// on a bare Express app — no Nest boot, no DB. `bootstrap()` itself can't run
// here (it needs a live Postgres connection), so this proves the middleware
// pair `bootstrap()` mounts, not the full NestFactory wiring around it.
//
// Regression coverage for Anton's security baseline (§2, CRITICAL): this
// entrypoint previously had no rate limiter at all, so /auth/login and every
// other route were completely unthrottled in production (main.ts's copy never
// runs on Vercel — see workspace CLAUDE.md §10 and api/index.js's own
// comments on `createRateLimiter`).
//
// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require('../api/index.js');

function buildApp(env: Record<string, string>) {
  const app = express();

  // Stand-in for `app.enableCors(...)` in bootstrap(): NestJS's CORS
  // middleware (the `cors` package, default `preflightContinue: false`)
  // answers an OPTIONS preflight and ends the chain there — before it
  // reaches any later middleware, including the rate limiter. This is a
  // minimal functional equivalent for that one property (OPTIONS never
  // reaches downstream middleware) so the ordering guarantee can be tested
  // without adding a `cors` dependency; it is not a re-test of NestJS's own
  // CORS logic, which is out of scope here.
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const [verticalMiddleware, limiterMiddleware] = handler.createRateLimiter(
    env,
  );
  app.use(verticalMiddleware);
  app.use(limiterMiddleware);

  app.get('/api/v1/auth/login', (_req, res) => res.json({ ok: true }));

  return app;
}

describe('api/index.js — createRateLimiter (e2e, no Nest boot, no DB)', () => {
  it('allows up to the configured max, then returns 429 with the MER-RATE-0001 envelope', async () => {
    const server = http.createServer(
      buildApp({
        RATE_LIMIT_MAX_GLOBAL: '3',
        RATE_LIMIT_MAX_IMMIGRATION: '3',
        RATE_LIMIT_MAX_BANKING: '3',
        RATE_LIMIT_TTL_MS: '60000',
      }),
    );

    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await request(server).get('/api/v1/auth/login'));
    }

    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 429, 429]);

    const blocked = results[3];
    expect(blocked.body.data).toBeNull();
    expect(blocked.body.error.code).toBe('MER-RATE-0001');
    expect(blocked.body.error.message).toMatch(/too many requests/i);
    expect(blocked.body.meta.version).toBe('v1');

    server.close();
  });

  it('does not throttle an OPTIONS preflight, however many are sent', async () => {
    // Deliberately a very low max — a GET at this max would 429 on the 3rd
    // request. If OPTIONS shared that budget even once, this test would
    // catch it.
    const server = http.createServer(
      buildApp({
        RATE_LIMIT_MAX_GLOBAL: '2',
        RATE_LIMIT_MAX_IMMIGRATION: '2',
        RATE_LIMIT_MAX_BANKING: '2',
        RATE_LIMIT_TTL_MS: '60000',
      }),
    );

    const preflights = [];
    for (let i = 0; i < 10; i++) {
      preflights.push(await request(server).options('/api/v1/auth/login'));
    }
    expect(preflights.every((r) => r.status === 204)).toBe(true);

    // Confirm the limiter is actually wired and this low — otherwise the
    // assertion above would be true for the wrong reason (a limiter that
    // never trips at all).
    const getResults = [];
    for (let i = 0; i < 3; i++) {
      getResults.push(await request(server).get('/api/v1/auth/login'));
    }
    expect(getResults.map((r) => r.status)).toEqual([200, 200, 429]);

    server.close();
  });

  it('applies the vertical-aware max via X-Vertical, same as src/main.ts', async () => {
    const server = http.createServer(
      buildApp({
        RATE_LIMIT_MAX_GLOBAL: '1',
        RATE_LIMIT_MAX_IMMIGRATION: '4',
        RATE_LIMIT_MAX_BANKING: '1',
        RATE_LIMIT_TTL_MS: '60000',
      }),
    );

    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(
        await request(server)
          .get('/api/v1/auth/login')
          .set('X-Vertical', 'immigration'),
      );
    }
    // All 4 succeed under the immigration-specific max (4) — under the
    // global max (1) the 2nd request would already have 429'd.
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);

    server.close();
  });
});
