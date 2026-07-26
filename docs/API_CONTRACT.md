# Meru Core — API Contract

> **Source of truth for the `meru-core` ↔ `meru-core-fe` integration.**
> The backend is authoritative. When the frontend and this document disagree, the frontend is wrong.
>
> Last verified against `meru-core` @ `feat/int-adapters-gcc-banking-and-immigration`.

---

## 1. Connection

| | Value |
|---|---|
| Global prefix | `/api/v1` |
| Local | `http://localhost:8000/api/v1` |
| Swagger UI | `/api` (note: **outside** the `api/v1` prefix) |
| Health | `GET /api/v1/health` — runs `SELECT 1` against Neon |
| Database | Neon Postgres 18.4, `ap-southeast-1` |

Frontend env var: `NEXT_PUBLIC_MERU_API_URL`.

---

## 2. Response envelope — read this first

**Every** successful response is wrapped by `ResponseEnvelopeInterceptor`
(`src/core/interceptors/response-envelope.interceptor.ts`):

```jsonc
{
  "data": { /* the actual payload */ },
  "meta": {
    "requestId": "uuid",
    "timestamp": "2026-07-26T00:00:00.000Z",
    "version": "v1",
    "pagination": { /* only when the handler returned a `pagination` key */ }
  },
  "error": null
}
```

Errors use the identical envelope with `data: null`, from `AllExceptionsFilter`
(`src/core/filters/http-exception.filter.ts`):

```jsonc
{
  "data": null,
  "meta": { "requestId": "uuid", "timestamp": "...", "version": "v1" },
  "error": {
    "code": "MER-AUTH-0001",
    "message": "Invalid credentials",
    "details": [ { "field": "email", "message": "...", "code": "VALIDATION" } ]
  }
}
```

Error codes: `400 → MER-VAL-0001`, `401 → MER-AUTH-0001` (or `MER-AUTH-0003` when
the message contains "expired"), `403 → MER-AUTH-0008`, `404 → MER-RES-0001`,
`409 → MER-RES-0002`, `429 → MER-RATE-0001`, `5xx → MER-SRV-0001`.

### Client rule

Unwrap `response.data.data`, and treat a non-null `error` as a thrown failure.
Note `pagination` lives on `meta`, **not** inside `data`.

> **Known frontend divergence.** The three apps currently disagree:
> - `governancex/lib/api/client.ts` — unwraps `.data`. **Correct.**
> - `meru-dashboard/lib/api/client.ts` — `isEnvelope` guard on `{data, meta, error}`. **Correct.**
> - `immistack/lib/api/client.ts:100` — returns `response.data` raw, **no unwrapping. Broken** — every live call returns the envelope where the payload is expected. Must be fixed.

---

## 3. Auth

Local Passport + bcrypt against the `users` table, HS256 signed with `JWT_SECRET`.
There is **no** Supabase Auth, no OIDC, no JWKS.

| Endpoint | Auth | Body | Returns (inside `data`) |
|---|---|---|---|
| `POST /auth/login` | public | `{ email, password }` | see below |
| `POST /auth/refresh` | public | `{ refresh_token }` | same shape as login |
| `POST /auth/logout` | public | `{ refresh_token }` | `{ success: true }` — idempotent |
| `POST /auth/register` | public | `CreateUserInput` | created user |
| `GET  /auth/profile` | Bearer | — | current user |

Login / refresh payload:

```jsonc
{
  "access_token": "jwt",
  "refresh_token": "opaque-96-hex",
  "expires_in": 3600,
  "token_type": "Bearer",
  "tenant_id": "uuid",
  "user": {
    "id": "uuid",
    "tenant_id": "uuid",
    "email": "admin@demo.com",
    "role": "firm_admin",
    "permissions": ["firm_admin"],
    "profile": { "first_name": "", "last_name": "", "avatar_url": null, "title": null }
  }
}
```

`user.role` is the single primary role the portals switch on; `permissions` is the
full role list. Logging in **revokes all other active sessions for that user**.

Refresh tokens are opaque (`crypto.randomBytes(48)`), stored SHA-256-hashed in
`sessions`, and **rotated** on every refresh — always persist the new one.

### Request headers

```
Authorization: Bearer <access_token>
X-Tenant-ID:   <tenant_id>
X-Vertical:    core | immigration | grc     (optional)
X-Environment: <env>                        (optional)
X-Request-ID:  <uuid>                       (optional; generated if absent)
```

### Demo credentials

Seeded by `scripts/seed-demo.js`. Tenant slug `demo`, vertical `immigration`.
Password for all four: `demo123`.

| Email | `user.role` |
|---|---|
| `admin@demo.com` | `firm_admin` |
| `staff@demo.com` | `staff` |
| `client@demo.com` | `client` |
| `platform@demo.com` | `platform_admin` |

---

## 4. Route table

All paths below are relative to `/api/v1`.

| Base | Notable routes |
|---|---|
| `/auth` | `login`, `refresh`, `logout`, `register`, `profile`, `saml/initiate`, `saml/callback` |
| `/health` | `GET /` |
| `/tenants` | tenant CRUD |
| `/tenant/settings` | `GET /`, `POST /` |
| `/config-packs` | config pack management |
| `/crm` | `POST entities`, `GET entities` |
| `/workflows` | `POST /`, `GET /`, `GET :id`, `POST instances`, `GET instances`, `GET instances/:id`, `GET instances/:id/transitions`, `POST instances/:id/transition` |
| `/forms` | `GET /`, `GET :id/render`, `POST :id/submissions`, `GET submissions`, `POST submissions/:id/submit` |
| `/tasks` | `GET /`, `GET my-work`, `POST :id/start`, `POST :id/complete`, `POST recurring-jobs` |
| `/documents` | `POST upload`, `GET /`, `GET :id/download`, `POST :id/analyze`, `GET entity/:entityType/:entityId` |
| `/analytics` | `GET reports`, `POST reports/:id/execute`, `GET widgets`, `GET widgets/:id/execute` |
| `/audit` | audit log query |
| `/ai` | AI gateway + engines |
| `/search` | `GET /`, `POST index/entity`, `POST index/bulk` |
| `/integrations` | `GET adapters`, `GET adapters/health`, `GET au/visa-status/:n`, `POST au/vevo-check`, `POST ae/screening`, `POST ae/str`, `POST sa/screening`, `POST sa/str` |
| `/orchestration` | `GET health`, `GET search/intelligent`, `GET entity/:id/insights` |
| `/notifications`, `/billing`, `/storage`, `/queue`, `/elasticsearch` | per-module CRUD |
| `/jobs` | `POST sla-watchdog`, `POST daily-billing` — **Vercel Cron only**, requires `Authorization: Bearer $CRON_SECRET` |

### Frontend routes that do NOT exist — fix these

| Frontend calls | Reality | Action |
|---|---|---|
| `/workflow` | Backend serves **`/workflows`** (plural) | Rename in `obligations`, `breaches`, `regulatory` services |
| `/iam/users` | No `iam` controller. `IamService.listUsers()` exists but is **not routed** | Keep on mock; needs a backend PR to expose |
| `/orchestration/agents` | Not implemented | Keep on mock |
| `/orchestration/events` | Not implemented | Keep on mock |
| `/integrations/screen` | Use `/integrations/ae/screening` or `/sa/screening` | Repoint |
| `/integrations/trade` | Not implemented | Keep on mock |
| `/integrations/vessel` | Not implemented | Keep on mock |
| `/auth/refresh` | **Now exists** ✅ | Enable refresh in all three apps |

---

## 5. CORS

Allowlist driven by `CORS_ALLOWED_ORIGINS` (comma-separated) on the backend.
Any new frontend origin must be added there and the backend redeployed, or the
browser will block it. `credentials: true`, so wildcard origins are not possible.

Allowed headers: `Content-Type`, `Authorization`, `X-Request-ID`, `X-Tenant-ID`,
`X-Vertical`, `X-Environment`.

---

## 6. `MOCK_MODE` — required frontend fix

`meru-dashboard` and `immistack` compute:

```ts
process.env.NEXT_PUBLIC_MOCK_MODE !== "false" || url.includes("localhost")  // ❌
```

The `||` means mock mode **cannot be disabled** while pointed at a localhost API.
`governancex` uses `&&`, which is correct. Standardize all three on `&&`.

---

## 7. Not available on Vercel

The backend runs as a single serverless function. Consequences:

- **BullMQ queue processing is off** — `JobProcessor`'s loop is gated behind `process.env.VERCEL`.
- **`@nestjs/schedule` cron does not fire.** Only `sla-watchdog` and `daily-billing` run, via Vercel Cron (2/day — Hobby plan limit). The other 7 jobs are dormant.
- **No rate limiting.** `express-rate-limit`'s in-memory store is per-lambda and meaningless across instances.
- **Elasticsearch is not configured.** `/search` (Postgres-backed) works; `/elasticsearch` does not.
- **Filesystem is read-only** except `/tmp`, so Regulatory Radar cannot write config packs.

## 8. Known gaps

- **RLS is not enforced.** The three RLS migrations are no-op stubs and the policies reference Supabase-only roles (`TO authenticated`). Tenant isolation is currently application-level only. Contradicts `CLAUDE.md` §6.4 — needs its own PR.
- **The 11 legacy migrations do not run against a fresh database.** Schema is materialized by `scripts/sync-schema.js` from the TypeORM entities.
