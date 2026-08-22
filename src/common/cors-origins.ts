/**
 * The browser-origin allowlist for CORS, shared by `src/main.ts` (local /
 * container boot) and `api/index.js` (the Vercel function, which loads the
 * compiled `dist/common/cors-origins.js`). One list, one place.
 *
 * `CORS_ALLOWED_ORIGINS` is ADDITIVE. It extends the built-in list; it never
 * replaces it. Before 2026-08-23 the env var replaced the defaults, and the
 * Production value — set once, 24 days earlier — listed the dashboard but not
 * the two product apps. Every browser call from govx-app.vercel.app and
 * immistack-plum.vercel.app was refused at preflight ("Network Error" on the
 * login page), while curl against the same API succeeded. A stale env value
 * must be able to *add* an origin, never silently drop one.
 */
const DEFAULT_ORIGINS = [
  // local dev — one port per app
  'http://localhost:3000', // meru-dashboard
  'http://localhost:3001', // governancex
  'http://localhost:3002', // immistack

  // custom domains (present or planned — harmless while unowned)
  'https://app.meru.com',
  'https://app.immistack.com',
  'https://immistack.com',
  'https://www.immistack.com',
  'https://api.immistack.com',
  // GovernanceX is app.govx.com; the governancex.com entries stay until DNS
  // has moved — removing them early takes the portal down for anyone still
  // served from the old origin.
  'https://app.govx.com',
  'https://api.govx.com',
  'https://app.governancex.com',
  'https://api.governancex.com',

  // Vercel aliases each product app is actually served from today.
  // meru-dashboard
  'https://meru-dashboard.vercel.app',
  'https://meru-dashboard-qognitionagencys-projects.vercel.app',
  // immistack product. The `immistack` Vercel project (alias immistack-plum,
  // owner of immistack.com) has the MARKETING site deployed into it since
  // 2026-08-22; the product lives in the `immistack-app` project.
  'https://immistack-app.vercel.app',
  'https://immistack-app-eta.vercel.app', // the alias Vercel actually granted
  'https://immistack-app-qognitionagencys-projects.vercel.app',
  'https://immistack-plum.vercel.app',
  'https://immistack-qognitionagencys-projects.vercel.app',
  'https://immistack-git-main-qognitionagencys-projects.vercel.app',
  // governancex
  'https://govx-app.vercel.app',
  'https://app-govx.vercel.app',
  'https://governancex.vercel.app',
  'https://governancex-three.vercel.app',
  'https://governancex-qognitionagencys-projects.vercel.app',
];

/** Split, trim, drop blanks, dedupe — and union with the defaults. */
export function corsOrigins(env: string | undefined = process.env.CORS_ALLOWED_ORIGINS): string[] {
  const extra = (env ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return Array.from(new Set([...DEFAULT_ORIGINS, ...extra]));
}
