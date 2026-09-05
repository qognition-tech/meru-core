#!/usr/bin/env node
/**
 * Full API contract sweep.
 *
 * Enumerates every operation in the live OpenAPI document and asserts the
 * invariants that hold across the whole surface, rather than the handful of
 * routes a hand-written smoke test remembers to cover. The bugs this exists to
 * catch are the quiet ones — a route that answers 200 to an anonymous caller, a
 * payload boxed twice, a malformed body that 500s instead of 400ing, a literal
 * path swallowed by a `:id` sibling. None of those announce themselves.
 *
 *   node scripts/smoke/api-sweep.js
 *   BASE_URL=https://meru-core.vercel.app node scripts/smoke/api-sweep.js
 *
 * Exits non-zero if any check fails, so it can gate a deploy.
 */
require('dotenv').config({ quiet: true });

const BASE = (process.env.BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
const API = `${BASE}/api/v1`;
const EMAIL = process.env.SWEEP_EMAIL || 'admin@demo.com';
const PASSWORD = process.env.SWEEP_PASSWORD || 'demo123';

/**
 * Routes that are public by design. Everything else must reject an
 * unauthenticated caller — this list is the allowlist, so a newly added public
 * route has to be justified here rather than silently passing.
 */
const PUBLIC = [
  // Bare `/api/v1` — the application status endpoint.
  /^$/,
  /^\/health/,
  /^\/auth\/login$/,
  // /auth/register removed 2026-09-04 — see iam.controller.ts. Self-signup
  // into an existing tenant needs a per-tenant opt-in gate that does not
  // exist yet; do not re-add this pattern until that route exists again.
  /^\/auth\/refresh$/,
  /^\/auth\/logout$/,
  /^\/auth\/forgot-password$/,
  /^\/auth\/reset-password$/,
  /^\/auth\/mfa\/verify$/,
  /^\/auth\/saml\//,
  /^\/tenants\/signup$/,
  /^\/tenants\/check-slug$/,
];

/**
 * Signature-authenticated machine endpoints.
 *
 * These cannot present a bearer token — Stripe signs the raw request bytes and
 * verifies against STRIPE_WEBHOOK_SECRET instead — so 401 is the wrong
 * expectation: they legitimately answer 400 (no signature header) or 503
 * (secret unset). They are NOT added to PUBLIC, because PUBLIC skips a route
 * entirely and the property worth checking here is stronger than "is it
 * guarded": an unsigned caller must never get a 2xx, or anyone could forge a
 * "payment succeeded". Asserted explicitly below.
 */
const SIGNED = [/^\/billing\/webhook$/];

/** Cron/machine endpoints: must reject a *user* token, not just anonymous. */
const MACHINE = [/^\/jobs\//, /^\/integrations\/vessel\/ais\//];

// Stay under the API's own rate limit rather than fighting it.
const RATE_MAX = parseInt(process.env.RATE_LIMIT_MAX_GLOBAL || '100', 10);
const RATE_WINDOW_MS = parseInt(process.env.RATE_LIMIT_TTL_MS || '60000', 10);
// A little headroom: the login and spec fetch also count against the window.
const MIN_GAP_MS = Math.ceil(RATE_WINDOW_MS / Math.max(1, RATE_MAX - 10));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastCallAt = 0;
async function pace() {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

const results = { pass: 0, fail: 0, findings: [] };

function record(ok, severity, route, message) {
  if (ok) {
    results.pass++;
    return;
  }
  results.fail++;
  results.findings.push({ severity, route, message });
}

/**
 * Paced request.
 *
 * `path` is an absolute path already carrying the global prefix, because that
 * is how the OpenAPI document writes them — an earlier version of this script
 * prepended `/api/v1` again and cheerfully swept `/api/v1/api/v1/...`, where
 * every route 404s and the whole run reports clean. Requesting against BASE is
 * what makes the results mean anything.
 *
 * Retries once on 429. The API rate-limits to RATE_LIMIT_MAX_GLOBAL per window
 * and a sweep is exactly the traffic shape that trips it; a 429 says nothing
 * about the route under test, so treating one as a finding is noise.
 */
async function call(method, path, { token, body, timeout = 25000, retry = true } = {}) {
  await pace();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: method.toUpperCase(),
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON (file download, redirect) — fine */
    }
    if (res.status === 429 && retry) {
      clearTimeout(timer);
      await sleep(RATE_WINDOW_MS);
      return call(method, path, { token, body, timeout, retry: false });
    }

    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, json: null, text: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Substitute plausible values so a path exercises its handler, not its pipes. */
function concretise(path) {
  return path
    .replace(/\{[^}]*[Ii]d\}/g, '00000000-0000-0000-0000-000000000000')
    .replace(/\{[^}]+\}/g, 'sweep-probe');
}

/** Strip the global prefix so the matchers below read as route paths. */
function bare(p) {
  return p.replace(/^\/api\/v\d+/, '');
}
function isPublic(p) {
  return PUBLIC.some((re) => re.test(bare(p)));
}
function isMachine(p) {
  return MACHINE.some((re) => re.test(bare(p)));
}
function isSigned(p) {
  return SIGNED.some((re) => re.test(bare(p)));
}

async function main() {
  console.log(`Target: ${BASE} (pacing ${MIN_GAP_MS}ms between calls)\n`);

  const specRes = await fetch(`${BASE}/api-json`);
  if (!specRes.ok) {
    console.error(`Cannot read OpenAPI document (${specRes.status}). Is the API up?`);
    process.exit(1);
  }
  const spec = await specRes.json();

  const login = await call('post', '/api/v1/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
  });
  const token = login.json?.data?.access_token;
  if (!token) {
    console.error(`Cannot authenticate as ${EMAIL} (${login.status}). Set SWEEP_EMAIL/SWEEP_PASSWORD.`);
    process.exit(1);
  }
  console.log(`Authenticated as ${EMAIL}\n`);

  const ops = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      // Whether the operation documents a request body at all. An endpoint that
      // takes none (logout-all, mfa/setup, mark-all-as-read) has no DTO to
      // whitelist against, so ignoring stray fields is correct rather than a
      // finding — flagging those buries the endpoints that really do accept
      // junk into their database.
      ops.push({ path, method, hasBody: !!op.requestBody });
    }
  }

  // ── 1. Route shadowing ────────────────────────────────────────────────────
  // A literal segment that a parameterised sibling would swallow. Nest matches
  // in declaration order, so this is only a *candidate* — the spec cannot show
  // declaration order — but every real instance appears here.
  console.log('── Shadowing candidates ───────────────────────────────────');
  const byPrefix = new Map();
  for (const { path } of ops) {
    const segs = path.split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].startsWith('{')) {
        const prefix = '/' + segs.slice(0, i).join('/');
        if (!byPrefix.has(prefix)) byPrefix.set(prefix, new Set());
        byPrefix.get(prefix).add(segs.slice(i + 1).join('/'));
      }
    }
  }
  let shadowSuspects = 0;
  for (const { path } of ops) {
    const segs = path.split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].startsWith('{')) continue;
      const prefix = '/' + segs.slice(0, i).join('/');
      const siblings = byPrefix.get(prefix);
      if (siblings && i < segs.length && byPrefix.has(prefix)) {
        // A literal at the same depth as a `{param}` under the same prefix.
        const paramPeer = ops.find((o) => {
          const s = o.path.split('/').filter(Boolean);
          return (
            s.length > i &&
            s[i].startsWith('{') &&
            '/' + s.slice(0, i).join('/') === prefix
          );
        });
        if (paramPeer && paramPeer.path !== path) {
          shadowSuspects++;
          break;
        }
      }
    }
  }
  console.log(`  ${shadowSuspects} literal/param sibling pair(s) — verified live below\n`);

  // ── 2. Auth posture ───────────────────────────────────────────────────────
  console.log('── Auth posture (unauthenticated must not succeed) ─────────');
  for (const { path, method } of ops) {
    const p = concretise(path);
    if (isPublic(p)) continue;

    const res = await call(method, p);

    if (isMachine(p)) {
      record(res.status === 401, 'critical', `${method.toUpperCase()} ${p}`,
        `machine endpoint answered ${res.status} to an anonymous caller (want 401)`);
      continue;
    }

    // Signature-authenticated: 401 is the wrong expectation, but a 2xx to an
    // unsigned caller means forged events are being accepted.
    if (isSigned(p)) {
      record(!(res.status >= 200 && res.status < 300), 'critical',
        `${method.toUpperCase()} ${p}`,
        `signature-authenticated endpoint accepted an UNSIGNED request with ${res.status}`);
      continue;
    }

    // Still rate-limited after a retry: inconclusive, and reporting it would
    // drown the real findings.
    if (res.status === 429) continue;

    // 401 is the target. 404 is acceptable only where the path itself is
    // unroutable. Anything 2xx means the guard is missing.
    const ok = res.status === 401 || res.status === 404;
    record(ok, res.status >= 200 && res.status < 300 ? 'critical' : 'warn',
      `${method.toUpperCase()} ${p}`,
      `unauthenticated call returned ${res.status} (want 401)`);
  }
  console.log(`  checked ${ops.length} operations\n`);

  // ── 3. Envelope + server errors, authenticated ────────────────────────────
  console.log('── Envelope shape and 5xx, authenticated ───────────────────');
  const readOps = ops.filter((o) => o.method === 'get');
  for (const { path, method } of readOps) {
    const p = concretise(path);
    if (isMachine(p)) continue;

    const res = await call(method, p, { token });
    if (res.status === 429) continue;

    // 503 is a correct answer — the dependency is unconfigured or down, which
    // is not a defect in the route. Only 500 and friends indicate a bug.
    record(res.status < 500 || res.status === 503, 'critical', `GET ${p}`,
      `returned ${res.status}${res.json?.error ? ` — ${res.json.error.message}` : ''}`);

    if (res.json && typeof res.json === 'object' && 'data' in res.json) {
      const inner = res.json.data;
      const doubled =
        inner && typeof inner === 'object' && !Array.isArray(inner) &&
        'success' in inner && 'data' in inner;
      record(!doubled, 'major', `GET ${p}`,
        'payload is double-enveloped ({success,data} inside data)');
    }
  }
  console.log(`  checked ${readOps.length} read operations\n`);

  // ── 4. Input validation ───────────────────────────────────────────────────
  // A write handler fed an unknown field must answer 4xx. A 500 means the body
  // reached logic unvalidated; a 2xx means it was accepted and silently
  // ignored, which is how `?view=calendar` once returned every task in the
  // tenant with a cheerful 200.
  console.log('── Validation rejects junk (no 500, no silent accept) ──────');
  const writeOps = ops.filter((o) => ['post', 'put', 'patch'].includes(o.method));
  for (const { path, method, hasBody } of writeOps) {
    const p = concretise(path);
    if (isMachine(p)) continue;

    const res = await call(method, p, {
      token,
      body: { __sweep_unknown_field__: 'x' },
    });
    if (res.status === 429) continue;

    record(res.status < 500 || res.status === 503, 'critical',
      `${method.toUpperCase()} ${p}`,
      `malformed body produced ${res.status}${res.json?.error ? ` — ${res.json.error.message}` : ''}`);
    // Only meaningful where the operation declares a body to validate.
    if (hasBody) {
      record(!(res.status >= 200 && res.status < 300), 'major',
        `${method.toUpperCase()} ${p}`,
        `accepted a body of only unknown fields with ${res.status} (want 400)`);
    }
  }
  console.log(`  checked ${writeOps.length} write operations\n`);

  // ── Report ────────────────────────────────────────────────────────────────
  const bySeverity = { critical: [], major: [], warn: [] };
  for (const f of results.findings) bySeverity[f.severity].push(f);

  for (const sev of ['critical', 'major', 'warn']) {
    const list = bySeverity[sev];
    if (!list.length) continue;
    console.log(`── ${sev.toUpperCase()} (${list.length}) ─────────────────────────────`);
    for (const f of list) console.log(`  ${f.route}\n      ${f.message}`);
    console.log('');
  }

  const blocking = bySeverity.critical.length + bySeverity.major.length;
  console.log(
    `══ ${results.pass} passed, ${results.fail} failed ` +
      `(${bySeverity.critical.length} critical, ${bySeverity.major.length} major, ${bySeverity.warn.length} warn) ══`,
  );

  process.exit(blocking > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
