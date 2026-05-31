# Meru RegOS — Full-Stack Development Strategy

> **Version**: 2.0 | **Status**: Living Document
> **Owner**: Meru Platform Team | **Last Updated**: 2026-05-30
>
> Guidelines for developing the Meru ecosystem — backend, frontends, and the integration layer between them.
> Post-Phase A/B/C cleanup and integration complete.

---

## Table of Contents

1. [Current State Assessment](#1-current-state-assessment)
2. [The Gap: Vision vs. Reality](#2-the-gap-vision-vs-reality)
3. [Architecture Decision: Frontend Strategy](#3-architecture-decision-frontend-strategy)
4. [Phase-by-Phase Development Plan](#4-phase-by-phase-development-plan)
5. [Shared Frontend Package Strategy](#5-shared-frontend-package-strategy)
6. [Backend Integration Guide for Frontend Developers](#6-backend-integration-guide-for-frontend-developers)
7. [Development Workflows](#7-development-workflows)
8. [Testing Strategy](#8-testing-strategy)
9. [Code Standards & Conventions](#9-code-standards--conventions)
10. [Environment & Deployment Matrix](#10-environment--deployment-matrix)

---

## 1. Current State Assessment

### 1.1 The Three Repositories

```
┌─────────────────────────────────────────────────────────────────────┐
│                 CURRENT STATE (May 30, 2026 — Post-Phases A/B/C)    │
│                                                                      │
│  meru-core (NestJS 11)           Immistack-app (Next.js 15.1)       │
│  ┌────────────────────────┐      ┌────────────────────────────┐     │
│  │ ✅ 14 modules cleaned   │      │ ✅ 4 portals (role-guarded) │     │
│  │ ✅ 48 DB entities       │◀────▶│ ✅ JWT auth + refresh flow │     │
│  │ ✅ RLS multi-tenancy    │ REST │ ✅ Zustand + Axios client  │     │
│  │ ✅ Swagger/OpenAPI      │      │ ✅ Kanban + dnd-kit        │     │
│  │ ✅ All 4 engines wired  │      │ ✅ shadcn/ui + Tailwind    │     │
│  │ ✅ UAE Central Bank INT │      │ ✅ Role-based middleware   │     │
│  │ ✅ AU HomeAffairs INT   │      │ ✅ Real API (no mocks)     │     │
│  │ ✅ Config packs on disk │      │ ✅ Next.js 15.1 (latest)   │     │
│  │ ✅ ScheduleModule once  │      └────────────────────────────┘     │
│  │ ✅ 6 unused pkgs removed│                                         │
│  └────────────────────────┘     Meru Dashboard (Next.js 15.1)       │
│                                  ┌────────────────────────────┐     │
│  GovernanceX (Next.js 15.1)     │ ✅ Platform + Admin portals │     │
│  ┌────────────────────────┐     │ ✅ JWT auth + Zustand      │     │
│  │ ✅ JWT auth + API client│     │ ✅ God View, Tenants       │     │
│  │ ✅ Zustand store         │     │ ✅ Config Packs, Modules   │     │
│  │ ✅ Next.js 15 + React 19│     │ ✅ System Health, Billing  │     │
│  │ ✅ Middleware (i18n+auth)│     │ ✅ Dark theme, shadcn/ui   │     │
│  │ ✅ Real backend connect  │     │ ✅ Connected to real API   │     │
│  │ ✅ 22 pages, i18n en/ar │     └────────────────────────────┘     │
│  └────────────────────────┘                                         │
│                                                                      │
│  Shared: packages/ui/ (AppShell, API client, auth stores, types)    │
│  Config: packages/config-packs/{au/immigration.json,ae/banking.json} │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 Maturity Scorecard

| Capability | meru-core | ImmiStack | GovernanceX | Meru Dashboard |
|---|---|---|---|---|
| **API Integration** | — (is the API) | Axios + API client | Axios + API client | Axios + API client |
| **Authentication** | JWT + RBAC + Passport | JWT + cookie + refresh | JWT + cookie + Zustand | JWT + cookie + Zustand |
| **State Management** | — | Zustand (3 stores) | Zustand (1 store) | Zustand (2 stores) |
| **Multi-tenancy** | RLS + domain routing | X-Tenant-ID header | X-Tenant-ID header | X-Tenant-ID header |
| **Mock/Dev Mode** | — | Feature-flagged | Disabled (real API) | Disabled (real API) |
| **i18n** | — | next-intl (en) | next-intl (en/ar, RTL) | — (en only) |
| **UI Components** | — | 22 shadcn/ui | 17 shadcn/ui | 8 shadcn/ui minimal |
| **Forms** | class-validator | react-hook-form + zod | react-hook-form + zod | react-hook-form |
| **Role-based routing** | @Roles + PolicyGuard | Middleware JWT decode | Middleware + i18n | Middleware |
| **Gov API Adapters** | AU + UAE (2 adapters) | AU via Integrations | UAE via Integrations | — |
| **Framework Version** | NestJS 11 | Next.js 15.1 | Next.js 15.1 | Next.js 15.1 |
| **React Version** | — | React 19 | React 19 | React 19 |

### 1.3 Critical Findings

1. **GovernanceX has zero backend connection.** It's a beautiful UI shell with no API client, no auth, no data fetching. It needs the same integration layer ImmiStack already has.

2. **Both frontends duplicate ~40% of code.** shadcn/ui components, layout patterns, providers, i18n setup, theme system, form validation helpers — all duplicated across two repos.

3. **ImmiStack's mock layer is superior.** It has a proper `mock-api.ts` router that intercepts Axios calls with regex patterns and realistic data. GovernanceX imports mock arrays directly into page components.

4. **GovernanceX has the better design system.** Its navy/teal/amber palette, custom CSS variables, animation keyframes, and glass-card effects are more polished than ImmiStack's simpler shadcn defaults.

5. **meru-core modules are built but untested against real frontend usage.** The API exists (Swagger at `/api`), but GovernanceX has never called it, and ImmiStack's mock layer may diverge from actual API shapes.

---

## 2. The Gap: Vision vs. Reality

### 2.1 What CLAUDE.md Promises vs. What Exists

| CLAUDE.md Vision | Current Reality | Gap |
|---|---|---|
| Monorepo: `meru/` with `apps/`, `packages/` | 3 separate repos | No shared code, no unified build, duplicated components |
| Shared UI package (`packages/ui/`) | Each frontend has its own shadcn/ui copy | Need to extract `@meru/ui` |
| Shared types (`packages/types/`) | Each frontend defines its own types | Need to extract `@meru/types` |
| SDK package (`packages/sdk/`) | ImmiStack has a hand-rolled Axios client | Need to extract `@meru/sdk` |
| Config packs (`packages/config-packs/`) | GovernanceX has `vertical.config.ts` | Need JSON schema + registry |
| 4 Specialist Engines | Zero implemented | Screening, DocIntel, Radar, Vessel |
| God View (`app.meru.com`) | Platform portal exists within ImmiStack | Need standalone admin app |
| Drizzle ORM (target) | TypeORM (current) | Migration path defined in STRATEGY.md |

### 2.2 The Immediate Priority

**Get GovernanceX calling a real API.** That's the single biggest gap. Everything else — monorepo migration, shared packages, specialist engines — is important but secondary to having both vertical frontends integrated with meru-core.

---

## 3. Architecture Decision: Frontend Strategy

### 3.1 The Fundamental Question

**Should ImmiStack and GovernanceX remain separate repos, or merge into a monorepo?**

#### Option A: Keep Separate Repos (Current)

```
immistack-app/          governancex/           meru-core/
├── app/                ├── app/               ├── src/
├── components/         ├── components/        ├── docs/
├── lib/                ├── lib/               └── docker-compose.yml
└── package.json        └── package.json
```

**Pros**: Independent deploy cadence, separate CI/CD, no cross-contamination risk, different teams can work independently.

**Cons**: Duplicated code (~40%), inconsistent patterns, harder to share improvements (ImmiStack's API client can't easily be reused by GovernanceX), two versions of every shadcn/ui component.

#### Option B: Monorepo with Shared Packages (CLAUDE.md Vision)

```
meru/
├── apps/
│   ├── immistack-app/       # Next.js 15 — Immigration vertical
│   ├── governancex-app/     # Next.js 14 → 15 — Banking GRC vertical
│   └── meru-admin/          # God View (new)
├── packages/
│   ├── core-api/            # meru-core (NestJS)
│   ├── ui/                  # @meru/ui — shared shadcn components
│   ├── types/               # @meru/types — shared TypeScript types
│   ├── sdk/                 # @meru/sdk — API client, auth, hooks
│   ├── config-packs/        # JSON vertical/country definitions
│   └── database/            # Drizzle schemas + migrations
└── infra/
    ├── terraform/
    └── docker/
```

**Pros**: Shared code lives in packages (DRY), consistent patterns, one TypeScript version, one PR can span backend + frontend, Turborepo can orchestrate builds.

**Cons**: Migration effort upfront, need Turborepo/Nx setup, CI/CD gets more complex, larger surface area for breaking changes.

### 3.3 Recommendation: Incremental Monorepo Migration

**Don't block on monorepo.** The priority is getting GovernanceX integrated with meru-core. But start the monorepo with the first shared package.

**Step-by-step approach:**

1. **Immediately**: Create `@meru/sdk` as a standalone npm package (or git submodule) that both frontends can consume. This is the API client, auth hooks, and TypeScript types.

2. **Short-term (1-2 months)**: Once GovernanceX is integrated and stable, migrate to a Turborepo monorepo. Start with `packages/ui` (shared shadcn components extracted from ImmiStack) and `packages/types`.

3. **Medium-term (3-6 months)**: Bring meru-core into the monorepo under `packages/core-api/`. Add `packages/config-packs/`. Add `apps/meru-admin/`.

4. **Long-term (6-12 months)**: Specialist engines as separate packages. Full monorepo with Turborepo build orchestration.

### 3.4 Frontend Unification: The Shared Layer

Regardless of monorepo timing, these MUST be shared between ImmiStack and GovernanceX:

```
@meru/sdk                    # npm package or workspace
├── client.ts                # Axios instance + interceptors (from ImmiStack)
├── auth.ts                  # Auth hooks (login, logout, refresh, useUser)
├── tenant.ts                # Tenant context hooks (useTenant, useModules)
├── api/
│   ├── cases.ts             # Typed API functions per domain
│   ├── entities.ts
│   ├── documents.ts
│   ├── tasks.ts
│   ├── workflows.ts
│   └── ...
├── hooks/
│   ├── useApiQuery.ts       # Wraps React Query + SDK client
│   ├── useApiMutation.ts
│   └── useWebSocket.ts
└── types/
    ├── meru.types.ts         # Core Meru entities (from ImmiStack)
    ├── vertical.types.ts     # Vertical-specific extensions
    └── api.types.ts          # Request/response shapes
```

**Immediate action**: Extract the SDK from ImmiStack's `lib/api/` and `lib/types/` into a shared package. Both frontends consume it. This is the highest-leverage unification you can do this week.

---

## 4. Phase-by-Phase Development Plan

### Phase 0: Foundation (Weeks 1-4) — "Connect the Dots"

**Goal**: GovernanceX calls meru-core for real. ImmiStack gets production-ready. SDK extracted.

#### Week 1-2: Extract @meru/sdk

| Task | Source | Target |
|---|---|---|
| Extract Axios client + interceptors | `immistack-app/lib/api/client.ts` | `@meru/sdk/client.ts` |
| Extract auth store + hooks | `immistack-app/lib/stores/auth.store.ts` | `@meru/sdk/auth.ts` |
| Extract tenant store + hooks | `immistack-app/lib/stores/tenant.store.ts` | `@meru/sdk/tenant.ts` |
| Extract core types | `immistack-app/lib/types/meru.types.ts` | `@meru/sdk/types/` |
| Extract API helper functions | `immistack-app/lib/api/` helpers | `@meru/sdk/api/` |
| Add mock layer as dev dependency | `immistack-app/lib/mocks/mock-api.ts` | `@meru/sdk/mock/` |

**Deliverable**: `@meru/sdk` npm package (or git submodule) with typed API client, auth, tenant context, and mock mode.

#### Week 2-3: Wire GovernanceX to @meru/sdk

| Task | Details |
|---|---|
| Install `@meru/sdk` in governancex | Replace inline mock imports with SDK |
| Add auth flow | Copy ImmiStack's login → token store → redirect pattern |
| Add middleware | Copy ImmiStack's `middleware.ts` for route protection |
| Add Zustand stores | Auth store + tenant store (from SDK) |
| Add React Query provider | Wrap root layout with QueryProvider |
| Replace mock data imports | GovernanceX pages call `apiGet()` instead of importing mock arrays |
| Add X-Tenant-ID header | All API calls scoped to tenant |

**Deliverable**: GovernanceX login → dashboard loads real data from meru-core.

#### Week 3-4: meru-core Stabilization

| Task | Details |
|---|---|
| Audit all API endpoints | Compare Swagger docs against ImmiStack's mock layer — fix discrepancies |
| Add missing endpoints | Any endpoint ImmiStack mocks but meru-core doesn't have yet |
| Response envelope consistency | All responses follow `{ data, meta, error }` format |
| Error handling standardization | Consistent error codes, messages, HTTP status codes |
| CORS configuration | Allow `immistack-app` and `governancex` origins |
| Rate limiting per vertical | Different limits for immigration vs. banking tenants |

**Deliverable**: meru-core API passes integration tests from both frontends.

### Phase 1: ImmiStack Production (Weeks 4-12) — "Ship the Beachhead"

**Goal**: ImmiStack in production with UAE immigration firms.

| Week | Focus | Key Tasks |
|---|---|---|
| 4-5 | Auth hardening | SSO/SAML implementation, MFA, session management, refresh token rotation |
| 5-6 | Onboarding wizard | Complete 7-step firm onboarding, integrate with Stripe for billing |
| 6-7 | Document pipeline | OCR integration (Arabic + English), S3 upload flow, virus scanning |
| 7-8 | Workflow engine | BPMN execution, SLA tracking, automated task assignment |
| 8-9 | Communications | WhatsApp Business API, email templates (SendGrid), SMS (Twilio) |
| 9-10 | AI command bar | Natural language → API calls, citation-backed responses, RAG on immigration docs |
| 10-11 | Testing & security | Penetration test, load test (500 concurrent), RLS audit |
| 11-12 | UAE launch | Production deploy, 20-firm onboarding, monitoring, support runbook |

### Phase 2: GovernanceX Integration (Weeks 6-18) — "Enterprise Play"

**Goal**: GovernanceX connected to meru-core, screening engine MVP, bank pilot.

This phase overlaps with ImmiStack production hardening (weeks 6-12).

| Week | Focus | Key Tasks |
|---|---|---|
| 6-8 | Upgrade GovernanceX | Next.js 14 → 15, adopt @meru/sdk, add Zustand + React Query |
| 8-10 | Sanctions screening | Screen Engine MVP: fuzzy matching (Levenshtein, Jaro-Winkler), OFAC/UN/EU list sync |
| 10-12 | GRC workflows | SAR filing, breach management, obligation tracking, audit trail |
| 12-14 | Trade finance | Vessel tracking (AIS data), document verification (bills of lading, invoices) |
| 14-16 | Finacle connector | Core banking integration, transaction monitoring, TBML risk scoring |
| 16-18 | Bank pilot | 1 UAE bank, sanctions screening + trade finance, feedback → iterate |

### Phase 3: Shared Platform (Weeks 12-24) — "Unify"

| Week | Focus | Key Tasks |
|---|---|---|
| 12-14 | Monorepo migration | Turborepo setup, move all repos into `meru/` monorepo |
| 14-16 | @meru/ui package | Extract shared shadcn components, storybook, design tokens |
| 16-18 | God View (meru-admin) | Platform admin UI — tenant management, config pack registry, analytics |
| 18-20 | Config pack system | JSON schema validation, version registry, hot-reload, Regulatory Radar MVP |
| 20-24 | Specialist engines | Document Intelligence Layer (OCR + fraud detection), Vessel Tracking at scale |

### Phase 4: Expansion (Weeks 24-48) — "Scale"

| Timeline | Milestone |
|---|---|
| M6-M12 | KSA country pack (Qiwa, SAMA, ZATCA), Canada country pack (IRCC, FINTRAC) |
| M12-M18 | Health vertical MVP (DHA/PDPL), Tax vertical MVP (ZATCA e-invoicing) |
| M18-M24 | UK + Australia country packs, self-service onboarding, config pack marketplace |
| M24-M36 | Horizontal AI API products, partner ecosystem, new verticals (Labour, Education) |

---

## 5. Shared Frontend Package Strategy

### 5.1 Package Architecture

```
@meru/
├── sdk/                       # @meru/sdk — npm package
│   ├── src/
│   │   ├── client.ts          # Axios instance, interceptors, token refresh
│   │   ├── auth/
│   │   │   ├── auth-store.ts  # Zustand auth store
│   │   │   ├── use-auth.ts    # Auth hooks
│   │   │   └── middleware.ts  # Next.js middleware helper
│   │   ├── tenant/
│   │   │   ├── tenant-store.ts
│   │   │   └── use-tenant.ts
│   │   ├── api/               # Typed API functions per domain
│   │   │   ├── auth.api.ts
│   │   │   ├── cases.api.ts
│   │   │   ├── entities.api.ts
│   │   │   ├── documents.api.ts
│   │   │   ├── tasks.api.ts
│   │   │   ├── workflows.api.ts
│   │   │   ├── payments.api.ts
│   │   │   ├── communications.api.ts
│   │   │   ├── analytics.api.ts
│   │   │   └── sanctions.api.ts
│   │   ├── hooks/
│   │   │   ├── use-api-query.ts    # React Query wrapper
│   │   │   ├── use-api-mutation.ts
│   │   │   └── use-websocket.ts
│   │   ├── mock/
│   │   │   ├── mock-api.ts         # Mock API router
│   │   │   ├── mock-data.ts        # Shared mock dataset
│   │   │   └── mock-mode.ts        # Mock mode detection
│   │   └── types/
│   │       ├── meru.types.ts
│   │       ├── api.types.ts
│   │       └── index.ts
│   ├── package.json
│   └── tsconfig.json
│
├── ui/                        # @meru/ui — npm package
│   ├── src/
│   │   ├── components/        # All shadcn/ui components
│   │   ├── layout/            # AppShell, Sidebar, Header
│   │   ├── shared/            # StatsCard, DataTable, EmptyState, PageHeader
│   │   ├── kanban/            # KanbanBoard, KanbanColumn, KanbanCard
│   │   ├── charts/            # Sparkline, VesselMap, KPI charts
│   │   ├── providers/         # ThemeProvider, QueryProvider
│   │   └── hooks/             # useSidebar, useReducedMotion, etc.
│   ├── package.json
│   └── tailwind.config.ts     # Shared design tokens
│
└── types/                     # @meru/types — npm package
    ├── src/
    │   ├── meru.types.ts
    │   ├── immigration.types.ts
    │   ├── banking.types.ts
    │   └── index.ts
    ├── package.json
    └── tsconfig.json
```

### 5.2 What Goes Where

| If it's... | It goes in... | Because... |
|---|---|---|
| API client, auth, tenant logic | `@meru/sdk` | Every frontend needs to talk to meru-core |
| Button, Card, Dialog, etc. | `@meru/ui` | Every frontend uses the same design system |
| AppShell, Sidebar, Header | `@meru/ui` | Layout pattern is identical across verticals |
| StatsCard, DataTable, EmptyState | `@meru/ui` | Shared across all portals |
| KanbanBoard | `@meru/ui` | ImmiStack and GovernanceX both have kanban workflows |
| TypeScript interfaces | `@meru/types` | Single source of truth for API shapes |
| Visa types, immigration enums | `immistack-app/lib/` | Vertical-specific, not shared |
| Sanctions types, GRC enums | `governancex-app/lib/` | Vertical-specific, not shared |
| Page components | Each app's `app/` directory | Pages are app-specific |
| Mock data for immigration | `@meru/sdk/mock/` (shared) + vertical overrides | Core entities shared, vertical data appends |
| Tailwind config, CSS variables | `@meru/ui` | Design tokens must be consistent |

### 5.3 Migration Order (Least Disruption)

1. **Types first** — `@meru/types` has no dependencies, used by everything
2. **SDK second** — `@meru/sdk` depends on `@meru/types`
3. **UI last** — `@meru/ui` is the biggest surface area, most effort to extract
4. **Config packs** — JSON schema + validation + registry, depends on types

---

## 6. Backend Integration Guide for Frontend Developers

### 6.1 How to Add a New Page That Talks to meru-core

This is the pattern every GovernanceX page needs to follow. Example: Sanctions Screening page.

```typescript
// Step 1: Define types (in @meru/types or locally until SDK is extracted)
interface SanctionedEntity {
  id: string;
  name: string;
  matchScore: number;
  listType: 'OFAC' | 'UN' | 'EU' | 'UK_HMT' | 'UAE_LOCAL';
  status: 'pending_review' | 'cleared' | 'escalated';
  matchedAt: string;
}

// Step 2: Define API function (in @meru/sdk or lib/api/)
import { apiGet, apiPost } from '@meru/sdk';

export const searchSanctions = (query: string) =>
  apiGet<SanctionedEntity[]>('/sanctions/search', { query });

export const screenEntity = (entityId: string) =>
  apiPost<SanctionedEntity>(`/sanctions/screen/${entityId}`);

// Step 3: Create a React Query hook
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export function useSanctionsSearch(query: string) {
  return useQuery({
    queryKey: ['sanctions', 'search', query],
    queryFn: () => searchSanctions(query),
    enabled: query.length >= 3, // Only search when 3+ chars
    staleTime: 60_000, // 1 minute
  });
}

export function useScreenEntity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: screenEntity,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sanctions'] });
    },
  });
}

// Step 4: Use in page component
'use client';

export default function SanctionsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const { data, isLoading, error } = useSanctionsSearch(searchQuery);
  const screenMutation = useScreenEntity();

  if (isLoading) return <SkeletonCard />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <div>
      <PageHeader title="Sanctions Screening" />
      <Input
        placeholder="Search sanctions lists..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
      />
      <DataTable
        data={data || []}
        columns={sanctionsColumns}
        onRowAction={(row) => screenMutation.mutate(row.id)}
      />
    </div>
  );
}
```

### 6.2 GovernanceX Migration: From Mock-Only to API-Backed

Every GovernanceX page currently follows this anti-pattern:

```typescript
// CURRENT (BAD): Direct mock import
import { mockSanctions } from '@/lib/mock/sanctions.mock';

export default function SanctionsPage() {
  const [data, setData] = useState(mockSanctions);
  // ... no loading state, no error state, no refetch
}
```

Must become:

```typescript
// TARGET (GOOD): API-backed with loading/error states
import { useSanctionsList } from '@/lib/api/sanctions'; // or @meru/sdk

export default function SanctionsPage() {
  const { data, isLoading, error, refetch } = useSanctionsList();

  if (isLoading) return <PageSkeleton />;
  if (error) return <ErrorBanner error={error} onRetry={refetch} />;
  if (!data?.length) return <EmptyState message="No sanctions alerts" />;

  return <DataTable data={data} columns={columns} />;
}
```

**Every page must handle four states**: loading, error, empty, and data. The mock-only pages only handle data.

### 6.3 Auth Flow Standardization

Both frontends must implement the exact same auth flow:

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Login   │     │  Store   │     │  Axios   │     │  meru-   │
│  Form    │     │  (Zustand│     │  Inter-  │     │  core    │
│          │     │  +local) │     │  ceptor  │     │          │
└────┬─────┘     └────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │               │                  │
     │ POST /auth/    │               │                  │
     │ login ──────────────────────────────────────────▶│
     │                │               │                  │
     │◀── { accessToken, refreshToken, user, tenant } ──│
     │                │               │                  │
     │ store tokens ─▶│               │                  │
     │ store user ───▶│               │                  │
     │ store tenant ─▶│               │                  │
     │ set cookie ───▶│               │                  │
     │                │               │                  │
     │ redirect ─────▶│               │                  │
     │                │               │                  │
     │                │    Every subsequent request:     │
     │                │               │                  │
     │                │               │ GET /cases       │
     │                │               │ Authorization:   │
     │                │               │ Bearer <token>   │
     │                │               │ X-Tenant-ID: <id>│
     │                │               │─────────────────▶│
     │                │               │                  │
     │                │        On 401:│                  │
     │                │               │◀──── 401 ───────│
     │                │               │                  │
     │                │               │ POST /auth/      │
     │                │               │ refresh ────────▶│
     │                │               │                  │
     │                │               │◀── new tokens ──│
     │                │               │                  │
     │                │ update store ▶│                  │
     │                │               │ retry original ─▶│
```

**Implementation reference**: `immistack-app/lib/api/client.ts` and `immistack-app/lib/stores/auth.store.ts`. These should be extracted into `@meru/sdk` as-is, since they're proven working.

### 6.4 Mock Mode: Development Without Backend

The SDK must support mock mode so frontend developers can work without running meru-core locally:

```typescript
// @meru/sdk/client.ts
const MOCK_MODE =
  process.env.NEXT_PUBLIC_MOCK_MODE !== 'false' &&
  (typeof window !== 'undefined' && window.location.hostname === 'localhost');

export async function apiGet<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  if (MOCK_MODE) {
    return mockApiCall('GET', url, params) as Promise<T>;
  }
  return client.get(url, { params }).then(r => r.data);
}
```

The mock router (`@meru/sdk/mock/mock-api.ts`) uses regex pattern matching with a 350ms simulated delay. Each vertical app provides its own mock data that extends the shared mock dataset:

```typescript
// @meru/sdk/mock/mock-api.ts
const MOCK_ROUTES: MockRoute[] = [
  { method: 'POST', pattern: /^\/auth\/login$/, handler: handleLogin },
  { method: 'GET',  pattern: /^\/cases$/,        handler: handleListCases },
  { method: 'GET',  pattern: /^\/cases\/(.+)$/,  handler: handleGetCase },
  // ... 30+ routes
];

// Vertical-specific: immistack-app overrides case data
// Vertical-specific: governancex-app overrides sanctions data
```

---

## 7. Development Workflows

### 7.1 Feature Development Flow

```
1. Define types        →  @meru/types (or app-local types/index.ts)
2. Add API endpoint     →  meru-core (controller + service + DTO)
3. Update Swagger       →  Automatic via NestJS decorators
4. Add SDK function     →  @meru/sdk (or app lib/api/)
5. Add React Query hook →  App hooks/ directory
6. Build UI component   →  App components/ directory
7. Add mock data        →  @meru/sdk (or app lib/mocks/)
8. Write tests          →  App __tests__/ directory
```

### 7.2 Running the Full Stack Locally

```bash
# Terminal 1: Backend
cd meru-core
docker-compose up -d postgres redis elasticsearch  # Infrastructure
npm run start:dev                                   # NestJS on :3000

# Terminal 2: Immigration Frontend
cd immistack-app
NEXT_PUBLIC_MERU_API_URL=http://localhost:3000/api/v1 npm run dev

# Terminal 3: GRC Frontend
cd governancex
NEXT_PUBLIC_MERU_API_URL=http://localhost:3000/api/v1 npm run dev
```

Or, with mock mode (no backend needed):

```bash
cd immistack-app
npm run dev  # MOCK_MODE is default on localhost
```

### 7.3 Docker Compose for Integration Testing

```yaml
# docker-compose.dev.yml — Full stack for integration testing
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: meru
      POSTGRES_USER: meru
      POSTGRES_PASSWORD: meru_dev

  meru-core:
    build: ./meru-core
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://meru:meru_dev@postgres:5432/meru
    depends_on: [postgres]

  immistack:
    build: ./immistack-app
    ports: ["3001:3000"]
    environment:
      NEXT_PUBLIC_MERU_API_URL: http://meru-core:3000/api/v1
    depends_on: [meru-core]

  governancex:
    build: ./governancex
    ports: ["3002:3000"]
    environment:
      NEXT_PUBLIC_MERU_API_URL: http://meru-core:3000/api/v1
    depends_on: [meru-core]
```

---

## 8. Testing Strategy

### 8.1 Testing Pyramid

```
         ╱─────╲
        ╱  E2E  ╲           Playwright: critical user journeys
       ╱─────────╲
      ╱ Integration╲        Supertest (backend) + React Testing Library (frontend)
     ╱───────────────╲
    ╱   Unit Tests    ╲      Jest (backend) + Vitest (frontend)
   ╱───────────────────╲
```

### 8.2 Backend Testing (meru-core)

| Layer | Tool | What to Test | Target Coverage |
|---|---|---|---|
| **Unit** | Jest | Services, guards, pipes, utility functions | ≥ 80% |
| **Integration** | Supertest | Controllers + database (test Postgres), RLS policies | All endpoints |
| **E2E** | Playwright | Full user flows: login → create case → upload doc → AI query | 10 critical paths |

**Critical test**: Multi-tenancy isolation — verify Tenant A cannot access Tenant B's data through any API endpoint.

### 8.3 Frontend Testing

| Layer | Tool | What to Test |
|---|---|---|
| **Unit** | Vitest + Testing Library | Components (StatsCard, DataTable), hooks (useAuth, useTenant), utilities |
| **Integration** | Vitest + MSW (Mock Service Worker) | Pages with mocked API responses — verify all 4 states (loading, error, empty, data) |
| **E2E** | Playwright | Cross-portal flows: admin creates case → staff processes → client uploads doc |

**MSW setup for frontend integration tests**:

```typescript
// tests/mocks/handlers.ts
import { http, HttpResponse } from 'msw';

export const handlers = [
  http.post('*/auth/login', () =>
    HttpResponse.json({
      data: { accessToken: 'test-token', user: mockUser, tenant: mockTenant },
      meta: { requestId: 'test', timestamp: new Date().toISOString() },
      error: null,
    })
  ),
  http.get('*/cases', () =>
    HttpResponse.json({
      data: mockCases,
      meta: { requestId: 'test', timestamp: new Date().toISOString(), total: mockCases.length },
      error: null,
    })
  ),
  // ... all endpoints
];
```

### 8.4 Contract Testing

Since the SDK types are the contract between frontend and backend, add **type-level contract tests**:

```typescript
// @meru/sdk/__tests__/contracts.test.ts
import type { MeruCase, MeruApiResponse } from '@meru/types';
import type { ApiClient } from '../client';

// Compile-time check: the API client returns types that match the SDK types
type AssertApiShape<T> = T extends ( ...args: any[] ) => Promise<MeruApiResponse<MeruCase[]>>
  ? true
  : never;

// Runtime check: swagger.json matches SDK types
describe('API Contract', () => {
  it('SDK types match Swagger spec', async () => {
    const swagger = await fetch('http://localhost:3000/api-json').then(r => r.json());
    const caseSchema = swagger.components.schemas.Case;
    // Validate SDK's MeruCase type against swagger schema
    expect(caseSchema.properties).toMatchObject({
      id: { type: 'string', format: 'uuid' },
      tenantId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: Object.values(CaseStatus) },
      // ...
    });
  });
});
```

---

## 9. Code Standards & Conventions

### 9.1 File Naming

```
✅ kebab-case for files:    user-profile.tsx, sanctions-search.ts
✅ PascalCase for components: UserProfile, SanctionsSearch
✅ camelCase for functions:  useAuth, searchSanctions
✅ UPPER_CASE for constants: MAX_RETRY_COUNT, DEFAULT_STALE_TIME
✅ kebab-case for directories: lib/api/, components/shared/
```

### 9.2 Component Structure

```typescript
// 1. Imports (grouped: React, third-party, internal)
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@meru/ui';
import { useSanctionsSearch } from '@/lib/api/sanctions';

// 2. Types (if local)
interface SanctionsPageProps {
  tenantId: string;
}

// 3. Component
export function SanctionsPage({ tenantId }: SanctionsPageProps) {
  // 3a. Hooks
  const [query, setQuery] = useState('');
  const { data, isLoading, error } = useSanctionsSearch(query);

  // 3b. Early returns (loading, error, empty)
  if (isLoading) return <SkeletonCard />;
  if (error) return <ErrorBanner error={error} />;
  if (!data?.length) return <EmptyState />;

  // 3c. Main render
  return (
    <div className="space-y-6">
      <PageHeader title="Sanctions Screening" />
      <DataTable data={data} columns={columns} />
    </div>
  );
}
```

### 9.3 API Call Pattern

```typescript
// Always use React Query for GET requests
const { data, isLoading, error } = useQuery({
  queryKey: ['cases', caseId],
  queryFn: () => apiGet<MeruCase>(`/cases/${caseId}`),
});

// Always use useMutation for POST/PATCH/PUT/DELETE
const createCase = useMutation({
  mutationFn: (data: CreateCaseDTO) => apiPost<MeruCase>('/cases', data),
  onSuccess: (newCase) => {
    queryClient.invalidateQueries({ queryKey: ['cases'] });
    toast.success('Case created');
  },
  onError: (error) => {
    toast.error(error.message);
  },
});
```

### 9.4 Environment Variables

```bash
# .env.local — never committed
NEXT_PUBLIC_MERU_API_URL=http://localhost:3000/api/v1
NEXT_PUBLIC_WS_URL=ws://localhost:3000/ws
NEXT_PUBLIC_MOCK_MODE=true           # Set to "false" to use real API
NEXT_PUBLIC_APP_NAME=GovernanceX     # Used in metadata, titles, emails
NEXT_PUBLIC_APP_URL=http://localhost:3002
NEXTAUTH_URL=http://localhost:3002
NEXTAUTH_SECRET=xxx

# .env.local.example — committed, documents all vars
```

### 9.5 Internationalization

```typescript
// Use next-intl for ALL user-facing strings. No hardcoded English.

// ✅ Good
import { useTranslations } from 'next-intl';
const t = useTranslations('sanctions');
<h1>{t('title')}</h1>
<EmptyState message={t('noResults')} />

// ❌ Bad
<h1>Sanctions Screening</h1>
<EmptyState message="No results found" />
```

Both apps currently have `messages/en.json`. GovernanceX has `messages/ar.json` (Arabic). Extend both to have full bilingual support:

```
messages/
├── en.json    # English
└── ar.json    # Arabic (RTL)
```

---

## 10. Environment & Deployment Matrix

### 10.1 Infrastructure Per Environment

```
                    ┌─────────────────────────────────────────┐
                    │          PRODUCTION                       │
                    │                                           │
                    │  api.meru.com     (Meru Core API)        │
                    │  api.immistack.com (Immigration API)     │
                    │  api.governancex.com (GRC API)           │
                    │                                           │
                    │  app.immistack.com  (Immigration UI)     │
                    │  app.governancex.com (GRC UI)            │
                    │  app.meru.com       (God View)           │
                    └─────────────────────────────────────────┘

                    ┌─────────────────────────────────────────┐
                    │          STAGING                          │
                    │                                           │
                    │  staging-api.meru.com                    │
                    │  staging-api.immistack.com               │
                    │  staging-api.governancex.com             │
                    │                                           │
                    │  staging-app.immistack.com               │
                    │  staging-app.governancex.com             │
                    └─────────────────────────────────────────┘

                    ┌─────────────────────────────────────────┐
                    │          DEVELOPMENT                      │
                    │                                           │
                    │  localhost:3000  (Meru Core API)         │
                    │  localhost:3001  (Immigration UI)        │
                    │  localhost:3002  (GovernanceX UI)        │
                    └─────────────────────────────────────────┘
```

### 10.2 CI/CD Pipeline

```
PR Open
  │
  ├── Type check (tsc --noEmit) — all packages
  ├── Lint (ESLint) — all packages
  ├── Unit tests (Jest / Vitest)
  ├── Integration tests (Supertest / MSW)
  └── Build check (next build / nest build)
      │
      ▼
PR Merged to main
  │
  ├── Build Docker images
  ├── Push to container registry
  ├── Deploy to staging
  ├── E2E tests (Playwright against staging)
  └── Deploy to production (manual approval)
```

### 10.3 Docker Image Strategy

One Docker image per app, configured by environment variables:

```dockerfile
# meru-core/Dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

```dockerfile
# immistack-app/Dockerfile (same for governancex)
FROM node:22-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

FROM base AS builder
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

The **same Docker image** serves all three verticals. The vertical is determined at runtime by the `Host` header, not by a different build:

```bash
# Deploy meru-core for immigration vertical
docker run -e VERTICAL=immigration -e NODE_ENV=production meru-core

# Deploy the same image for GRC vertical
docker run -e VERTICAL=banking -e NODE_ENV=production meru-core
```

---

## Appendix A: GovernanceX Upgrade Checklist

### A.1 Immediate (Week 1-2)

- [ ] Upgrade Next.js from 14.2.35 to 15.1.11
- [ ] Install `@meru/sdk` (or copy from ImmiStack temporarily)
- [ ] Install missing dependencies:
  - [ ] `@tanstack/react-query` (server state)
  - [ ] `zustand` (client state)
  - [ ] `axios` (HTTP client)
  - [ ] `next-auth@beta` (authentication)
  - [ ] `sonner` (toast notifications)
- [ ] Add `middleware.ts` for route protection
- [ ] Add `.env.local.example`

### A.2 Integration (Week 2-4)

- [ ] Replace all inline mock imports with API calls
- [ ] Add Zustand stores: auth, tenant, ui
- [ ] Add React Query provider to root layout
- [ ] Add login page with real auth flow
- [ ] Add loading/error/empty states to ALL pages
- [ ] Add `X-Tenant-ID` header to all requests
- [ ] Verify all 20+ pages work against meru-core

### A.3 Polish (Week 4-6)

- [ ] Dark mode testing on all pages
- [ ] Arabic/RTL testing on all pages
- [ ] Responsive testing (mobile, tablet, desktop)
- [ ] Accessibility audit (WCAG 2.1 AA)
- [ ] Performance audit (Lighthouse > 90)
- [ ] Remove all dead mock files

---

## Appendix B: Quick Reference — SDK API

```typescript
// Authentication
import { login, logout, refreshToken, useCurrentUser } from '@meru/sdk/auth';

// Tenant
import { useTenant, useTenantModules, useIsModuleEnabled } from '@meru/sdk/tenant';

// Data fetching (React Query wrappers)
import { useApiQuery, useApiMutation } from '@meru/sdk/hooks';

// Direct API calls (when not using React Query)
import { apiGet, apiPost, apiPatch, apiPut, apiDelete, apiUpload } from '@meru/sdk/client';

// Types
import type {
  MeruUser, MeruTenant, MeruCase, MeruTask, MeruDocument,
  MeruPayment, MeruCommunication, MeruApiResponse, MeruApiError,
  UserRole, CaseStatus, TaskStatus, PaymentStatus,
} from '@meru/sdk/types';

// Mock mode (development)
import { enableMockMode, disableMockMode, isMockMode } from '@meru/sdk/mock';
```

---

## 11. Government API Adapters (INT Module)

### 11.1 Adapter Registry

The INT module registers adapters implementing the `GovernmentAdapter` interface. Each adapter handles a specific regulator's API.

| Adapter ID | Country | Regulator | Capabilities | Status |
|---|---|---|---|---|
| `au-home-affairs` | AU | Department of Home Affairs | visa_status, application_status, sponsor_validation, vevo_check, lodge_application | Active |
| `uae-central-bank` | AE | Central Bank of the UAE | screening, sar_filing, document_verification, identity_verification | Active |

### 11.2 Adding a Country Adapter

1. Create `src/integrations/adapters/{country}-{regulator}.adapter.ts`
2. Implement `GovernmentAdapter` interface from `interfaces/government-adapter.interface.ts`
3. Register in `integrations.module.ts` providers array
4. Add to `integrations.service.ts` constructor for auto-registration
5. Add controller endpoints in `integrations.controller.ts`
6. Add the regulator to the relevant config pack JSON

### 11.3 Adapter Endpoints

**AU HomeAffairs** (prefix: `api/v1/integrations/au/`):
- `GET /visa-status/:visaNumber?passportNumber=` — Visa status check
- `GET /application-status/:applicationId` — Application tracking
- `GET /sponsor-validation?abn=` — Employer sponsor validation
- `POST /vevo-check` — VEVO visa entitlement verification

**UAE Central Bank** (prefix: `api/v1/integrations/ae/`):
- `POST /screening` — Sanctions screening against UN/OFAC/UAE lists
- `POST /str` — File Suspicious Transaction Report with CBUAE
- `GET /regulatory-updates?category=&since=` — CBUAE circulars/updates
- `GET /verify-entity/:licenseNumber` — Trade license verification

---

## 12. Config Packs

### 12.1 Location

```
packages/config-packs/
  _schema/config-pack.schema.json    # JSON Schema validator
  au/immigration.json                 # Australian immigration vertical
  ae/banking.json                     # UAE banking GRC vertical
```

### 12.2 Config Pack Structure

Each pack is a JSON document with:
- **Metadata**: code, name, version, vertical, country
- **Regulators**: IDs, adapters, endpoint mappings
- **Domain Logic**: Workflow stages, document requirements, roles/permissions, features

### 12.3 Adding a New Config Pack

1. Create `packages/config-packs/{country}/{vertical}.json`
2. Validate against `_schema/config-pack.schema.json`
3. The `ConfigPackLoaderService` auto-seeds it at boot (per CLAUDE.md)
4. Pack is version-pinned to tenants via the TCM module

### 12.4 Available Packs

| Pack Code | Vertical | Country | Version | Regulators |
|---|---|---|---|---|
| `au-immigration` | Immigration | AU | 2.4.1 | AU HomeAffairs |
| `ae-banking` | Banking GRC | AE | 3.1.2 | CBUAE, UAE FIU |

---

## 13. Three-Portal Architecture

```
meru-core-fe/
  packages/ui/          # Shared components, API client, auth stores
  meru-dashboard/        # Platform admin portal (port 3000)
    /platform/           # God View, Tenants, Modules, Billing
    /admin/              # Config Packs, Feature Flags, System Health
  governancex/            # Banking GRC portal (port 3001)
    /(dashboard)/        # 22 pages across sanctions, regulatory, SAR, etc.
  immistack/              # Immigration portal (port 3002)
    /admin/              # Firm admin — cases, clients, leads, billing
    /staff/              # Staff — my-cases, tasks, clients
    /client/             # Client — own case, documents, payments
    /platform/           # Platform admin — god view, tenants
```

Each portal connects to `api/v1/auth/login` for JWT authentication and uses cookie-based middleware for route protection.

---

*Last updated: 2026-05-30 — Phases A, B, C complete*
*Document owner: Meru Platform Team*
