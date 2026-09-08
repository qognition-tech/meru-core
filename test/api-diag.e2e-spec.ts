import http from 'node:http';
import request from 'supertest';

// Exercises api/index.js's `__diag` gate in isolation, WITHOUT booting Nest
// and WITHOUT a live database — every case here either returns from the diag
// branch directly or asserts against the exported pure functions, neither of
// which touches `bootstrap()`.
//
// This spec previously had a 5th case ("does not match a path that merely
// contains '__diag' as a substring") that requested a non-matching path over
// real HTTP. That request falls through to `bootstrap()`, which loads
// `dist/src/app.module`, runs `ConfigModule`'s Joi validation against this
// repo's real `.env` (a live `DATABASE_URL`) and attempts an actual Postgres
// connection — which hung for 9+ minutes in review (Owen,
// scratchpad/reports/owen-luke-api-review.md §4) rather than failing fast.
// That case is now a plain assertion against the exported `diagPathname` /
// `DIAG_PATHS`, which is what it was actually testing (the routing decision,
// not anything about bootstrap) — no HTTP, no Nest, no DB, ever.
//
// Regression coverage for Anton's security baseline (§1, CRITICAL): __diag
// used to answer any request whose URL merely contained "__diag" with
// unauthenticated secret lengths, and accepted `?db=1`/`?boot=1` from anyone.
//
// Uses `require` because api/index.js is deliberately plain CommonJS (see its
// own header comment on why — esbuild + emitDecoratorMetadata).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require('../api/index.js');

describe('api/index.js — __diag (e2e, no Nest boot, no DB)', () => {
  let server: http.Server;
  const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

  beforeAll(() => {
    server = http.createServer((req, res) => {
      void (handler as (req: unknown, res: unknown) => Promise<void>)(
        req,
        res,
      );
    });
  });

  afterAll(() => {
    server.close();
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  });

  it('returns 404, not the report, when CRON_SECRET is unset (fail closed)', async () => {
    delete process.env.CRON_SECRET;
    const res = await request(server).get('/api/__diag');
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('MER-RES-0001');
    expect(res.body.env).toBeUndefined();
  });

  it('returns 404 when Authorization header is missing', async () => {
    process.env.CRON_SECRET = 'a'.repeat(64);
    const res = await request(server).get('/api/__diag');
    expect(res.status).toBe(404);
  });

  it('returns 404 when the bearer token is wrong', async () => {
    process.env.CRON_SECRET = 'a'.repeat(64);
    const res = await request(server)
      .get('/api/__diag')
      .set('Authorization', 'Bearer wrong-secret');
    expect(res.status).toBe(404);
  });

  it('returns the report, with lengths never disclosed, on the correct bearer token', async () => {
    process.env.CRON_SECRET = 'a'.repeat(64);
    // These two are read only via the exported, parameterised `diagReport`
    // below for the "lengths never disclosed" assertion — passed as an
    // explicit fake env, never written to `process.env`, so this case can
    // never accidentally exercise the real `.env`/DATABASE_URL path.
    const res = await request(server)
      .get('/api/v1/__diag')
      .set('Authorization', `Bearer ${process.env.CRON_SECRET}`);

    expect(res.status).toBe(200);
    // The live report (against whatever real env this process happens to
    // have) must still never leak a length or a raw value.
    expect(JSON.stringify(res.body)).not.toMatch(/"set\(\d+\)"/);
  });

  it('diagReport(env) reports set/UNSET/EMPTY only, never a length or raw value', () => {
    const fakeEnv = {
      JWT_SECRET: 'x'.repeat(40),
      DATABASE_URL: 'postgres://user:pass@host/db',
      NODE_ENV: '',
    };
    const report = handler.diagReport(fakeEnv);
    expect(report.env.JWT_SECRET).toBe('set');
    expect(report.env.DATABASE_URL).toBe('set');
    expect(report.env.NODE_ENV).toBe('EMPTY');
    expect(report.env.CRON_SECRET).toBe('UNSET');
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('pass@host');
    expect(serialised).not.toMatch(/"set\(\d+\)"/);
  });

  it('isDiagAuthorized(req, secret) fails closed on an unset/blank secret', () => {
    // `handler` comes from `require(...)`, so it and everything hung off it
    // is untyped (`any`) — plain object literals are fine here, no cast
    // needed; `isDiagAuthorized` only reads `req.headers.authorization`.
    const req = { headers: { authorization: 'Bearer anything' } };
    expect(handler.isDiagAuthorized(req, undefined)).toBe(false);
    expect(handler.isDiagAuthorized(req, '')).toBe(false);
    expect(handler.isDiagAuthorized(req, '   ')).toBe(false);
  });

  it('isDiagAuthorized(req, secret) matches only the correct bearer token', () => {
    const secret = 'a'.repeat(64);
    const wrongHeader = { headers: { authorization: 'Bearer wrong' } };
    const missingHeader = { headers: {} };
    const correctHeader = { headers: { authorization: `Bearer ${secret}` } };

    expect(handler.isDiagAuthorized(wrongHeader, secret)).toBe(false);
    expect(handler.isDiagAuthorized(missingHeader, secret)).toBe(false);
    expect(handler.isDiagAuthorized(correctHeader, secret)).toBe(true);
  });

  it('matches the diag path exactly — never as a substring', () => {
    // This is the case that used to fire a real HTTP request at a
    // non-matching path and fall through to `bootstrap()` (see the file
    // header). The only thing it was ever actually testing is the routing
    // decision, which is a pure function of the URL — assert that directly.
    expect(handler.DIAG_PATHS.has(handler.diagPathname('/api/__diag'))).toBe(
      true,
    );
    expect(
      handler.DIAG_PATHS.has(handler.diagPathname('/api/v1/__diag')),
    ).toBe(true);
    expect(
      handler.DIAG_PATHS.has(handler.diagPathname('/api/__diag?boot=1')),
    ).toBe(true);
    // Substring matches must NOT match — this is the exact regression Anton
    // found (`.includes('__diag')` matched anything containing the string).
    expect(
      handler.DIAG_PATHS.has(handler.diagPathname('/foo__diagnostics')),
    ).toBe(false);
    expect(
      handler.DIAG_PATHS.has(handler.diagPathname('/api/__diagnostics')),
    ).toBe(false);
  });
});
