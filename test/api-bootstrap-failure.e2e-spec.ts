import http from 'node:http';
import request from 'supertest';

// Exercises api/index.js's bootstrap-failure catch block in isolation, WITHOUT
// a live database and WITHOUT a real Nest boot. `dist/src/app.module` is
// mocked to throw the moment it is required — the same failure shape as a
// bad env var (ConfigModule's Joi validation throws at import time, see the
// comment above `bootstrap()` in api/index.js) or an unreachable Postgres
// host, without actually needing either.
//
// Regression coverage: this handler used to answer every unauthenticated
// caller, on any route, with `error.detail: String(stack).slice(0, 2000)` —
// the real stack trace of whatever crashed boot, including absolute file
// paths, module names and sometimes a fragment of a connection string from
// the underlying driver's error. Fixed by dropping `detail` from the
// response and keeping it in `console.error` only. This spec exists so that
// fix cannot silently regress — api/index.js and src/main.ts are the
// documented drift point in this repo (CLAUDE.md §8.6), and unit tests do
// not otherwise exercise api/index.js at all.
const BOOT_ERROR_MESSAGE =
  'Config validation error: "JWT_SECRET" is required — simulated for this spec, not a real env failure';

jest.mock('../dist/src/app.module', () => {
  throw new Error(BOOT_ERROR_MESSAGE);
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require('../api/index.js');

describe('api/index.js — bootstrap failure (e2e, no Nest boot, no DB)', () => {
  let server: http.Server;
  let consoleErrorSpy: jest.SpyInstance;

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

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {
      /* silence expected [bootstrap-failed] log during assertions */
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('answers 500 with the real envelope shape and MER-SRV-0002, not the boot error', async () => {
    const res = await request(server).get('/api/v1/health');

    expect(res.status).toBe(500);
    // { data, meta, error } — the same envelope on error as on success
    // (workspace CLAUDE.md §11). No bare `success` field, no re-wrap.
    expect(res.body).toEqual({
      data: null,
      meta: {
        requestId: expect.any(String),
        timestamp: expect.any(String),
        version: 'v1',
      },
      error: {
        code: 'MER-SRV-0002',
        message: 'Service temporarily unavailable',
        helpUrl: 'https://docs.meru.dev/errors#mersrv0002',
      },
    });
  });

  it('never leaks a `detail` field or the underlying error text to the caller', async () => {
    const res = await request(server).get('/api/v1/health');

    expect(res.body.error.detail).toBeUndefined();
    // Guards against the leak returning under a different key name, not just
    // `detail` — assert the raw response body never contains the thrown
    // message, a stack frame marker, or this file's own absolute path.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(BOOT_ERROR_MESSAGE);
    expect(raw).not.toContain('.js:');
    expect(raw).not.toContain(__dirname);
  });

  it('still logs the real cause server-side, so an operator can diagnose it', async () => {
    await request(server).get('/api/v1/health');

    const logged = consoleErrorSpy.mock.calls
      .map((args) => args.join(' '))
      .join('\n');
    expect(logged).toContain('[bootstrap-failed]');
    expect(logged).toContain(BOOT_ERROR_MESSAGE);
  });
});
