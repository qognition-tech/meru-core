# CLAUDE.md — MERU REGULATORY OPERATING SYSTEM (RegOS)

> **Single source of truth** for all engineering, architectural, and product decisions across the Meru ecosystem.
> Every PR, agent action, and new vertical MUST comply with this document.
>
> **Detailed specifications** are in the `docs/` directory:
> - [ARCHITECTURE.md](docs/ARCHITECTURE.md) — Definitive system architecture & design
> - [PRD.md](docs/PRD.md) — Product requirements for all stakeholders
> - [TRD.md](docs/TRD.md) — Detailed technical specifications for implementation
> - [STRATEGY.md](docs/STRATEGY.md) — Business strategy, GTM, pricing & roadmap
> - [DEVELOPMENT_STRATEGY.md](docs/DEVELOPMENT_STRATEGY.md) — Full-stack development guidelines & integration strategy
> - [DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) — Complete database design, 47 tables, RLS policies
> - [DESIGN_GUIDELINES.md](docs/DESIGN_GUIDELINES.md) — Brand system, component library, layout patterns

---

## 0. EXECUTIVE SUMMARY

**Meru** is a **Regulatory Operating System (RegOS)** — the *government API layer of the internet*. It abstracts **80% of regulatory plumbing** into a single horizontal engine, then uses **JSON Configuration Packs** to handle the remaining 20% of vertical- and country-specific logic.

| Layer | What It Is | Build Time per New Vertical |
|---|---|---|
| **Meru Core** (`api.meru.com`) | 14 horizontal services + 4 specialist engines | One-time (already built) |
| **Vertical Logic Packs** | JSON injection (forms, workflows, regulators) | **Weeks**, not 12 months |
| **Vertical UIs** | ImmiStack, GovernanceX, Health, Tax, … | 2–6 weeks per vertical |

**Strategic moat:** mastering the **Common Corridor** (UAE, KSA, UK, Canada, Australia) means once a regulator is wired into Meru, every vertical inherits it for free.

---

## 1. VISION & DOMAIN ARCHITECTURE

### 1.1 The Three Pillars

```
┌─────────────────────────────────────────────────────────────────┐
│                    MERU REGULATORY OS                            │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │   PILLAR 1   │    │   PILLAR 2   │    │    PILLAR 3       │   │
│  │              │    │              │    │                   │   │
│  │  MERU CORE   │───▶│  IMMISTACK   │    │  GOVERNANCEX     │   │
│  │  (Engine)    │    │  (Immig.)    │    │  (Banking GRC)   │   │
│  │              │    │              │    │                   │   │
│  │  14 Modules  │    │  Next.js 15  │    │  Modular Monolith│   │
│  │  4 Engines   │    │  3 Portals   │    │  150+ tRPC routers│  │
│  │  JSON Packs  │    │  Kanban+Chat │    │  216 DB tables   │   │
│  └──────────────┘    └──────────────┘    └──────────────────┘   │
│         ▲                                                        │
│         │  Future: Health, Tax, Labour, Education (JSON packs)  │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Domain Mapping & Environment Roles

| Domain | Tier | Purpose |
|---|---|---|
| `app.meru.com` | **God UI** | Expansion control: vertical/country registration, tenant health, feature flags, config-pack publishing |
| `api.meru.com` | **Core API** | RegOS Engine — the 14 shared modules + 4 specialist engines |
| `app.immistack.com` | Vertical UI | Immigration portal: Firm Admins, Staff, Clients |
| `api.immistack.com` | Vertical API | Injects the Immigration JSON pack into Meru Core |
| `app.governance.com` | Vertical UI | Banking GRC interface (Sanctions, Trade Finance, AML) |
| `api.governance.com` | Vertical API | Banking-specific orchestration over Meru Core |
| `immistack.com` | Web | Marketing landing page |
| `governance.com` | Web | Marketing landing page |

---

## 2. THE 14 CORE MODULES (`api.meru.com`)

Each module is **independently deployable** and consumed by every vertical pack via stable contracts.

| # | Code | Module | Responsibility |
|---|---|---|---|
| 1 | **IAM** | Identity & Access | OAuth2 / OIDC / RBAC / ABAC, MFA, SSO, session brokering |
| 2 | **TCM** | Tenant Config & Settings | Config-pack validation, routing, version pinning per tenant |
| 3 | **CRM** | Universal Entity Manager | Polymorphic entities: Person, Case, Asset, Organization |
| 4 | **SRCH** | Universal Search | Elasticsearch + hybrid vector search (BM25 + embeddings) |
| 5 | **AI** | AI Orchestration Gateway | Token mgmt, model routing, citation enforcement, RAG |
| 6 | **WF** | Workflow & State Machine | BPMN processes, SLA tracking, escalations |
| 7 | **FORM** | Dynamic Form Builder | JSON-schema-driven UI rendering & validation |
| 8 | **TASK** | Task & Activity Manager | Assignments, deadlines, dependencies, reminders |
| 9 | **COM** | Communication Hub | WhatsApp, SMS, Email, multi-lingual templates |
| 10 | **DOC** | Document Manager | OCR, versioning, S3 abstraction, e-signature hooks |
| 11 | **BILL** | Billing & Metering | Stripe / usage-based billing, per-seat, per-case, per-API-call |
| 12 | **BI** | Analytics & BI Engine | Embedded dashboards, KPI posture scoring |
| 13 | **AUD** | Audit & Compliance Logger | Tamper-evident logs (hash-chained), WORM storage |
| 14 | **INT** | Integration Hub | Government API adapters (MOHRE, Qiwa, HomeAffairs, IRCC, etc.) |

**Contract rule:** every module exposes a versioned tRPC router *and* a REST/OpenAPI surface. Internal calls = tRPC; external partners = REST.

---

## 3. SPECIALIST ENGINES (Cross-Vertical Logic)

These four engines sit **alongside** the 14 modules and provide cross-vertical "horizontal AI" capabilities. Every vertical pack can opt-in.

### 3.1 Regulatory Radar 🛰️
- **What:** Autonomous AI agents that continuously crawl official government sources (gazettes, regulator portals, RSS, change logs).
- **Output:** Flags rule changes → auto-drafts **config-pack diffs** → submits PR to `packages/config-packs` for human review.
- **Tech:** Scheduled crawlers, diff embeddings, LLM with citation enforcement, Git-based change proposals.
- **Consumed by:** All verticals.

### 3.2 Screening Engine 🎯
- **What:** High-performance fuzzy-logic matching for **Sanctions, PEP, Adverse Media** screening.
- **Algorithms:** Levenshtein, Jaro-Winkler, Soundex, transliteration normalization (Arabic ↔ Latin), entity resolution.
- **Lists:** OFAC, EU, UN, UK HMT, UAE Local, plus client custom watchlists.
- **Performance target:** sub-200ms p95 per name screened; batch mode > 10k names/min.
- **Consumed by:** GovernanceX (primary), ImmiStack (KYC on applicants), Tax (UBO checks).

### 3.3 Document Intelligence Layer 📄
- **What:** Advanced AI for OCR, structured-data extraction, and **fraud pattern detection** in submitted files.
- **Capabilities:**
  - Multi-language OCR (Arabic, English, Urdu, Tagalog, Hindi)
  - Layout-aware extraction (passports, payslips, bank statements, contracts, bills of lading)
  - Fraud signals: tampering, font inconsistencies, EXIF anomalies, duplicate detection across tenants (privacy-preserved hashing)
- **Consumed by:** All verticals — Immigration (visa docs), Banking (trade finance docs), Health (credentials), Tax (invoices).

### 3.4 Vessel / Asset Tracking Engine 🚢
- **What:** Real-time **AIS data** integration + geofencing for trade finance and supply chain compliance.
- **Data:** AIS feeds, port call logs, sanctioned-port geofences, dark-fleet detection (AIS gaps).
- **Output:** Vessel risk score, port-call timeline, sanctioned-route alerts.
- **Consumed by:** GovernanceX (Trade Finance); extensible to logistics verticals.

---

## 4. THE FOUR-LAYER CONFIG-INJECTION MODEL

This is **the architectural heart** of Meru. 80% of code is shared; the remaining 20% is JSON.

```
┌──────────────────────────────────────────────────────────────┐
│ LAYER 4: VERTICAL LOGIC PACKS (JSON)                         │
│ Immigration · Banking · Health · Tax · Labour · Education    │
│ ────────────────────────────────────────────────────────────│
│ LAYER 3: COUNTRY OVERLAYS (JSON)                             │
│ UAE · KSA · UK · CA · AU · regulator endpoints & local rules │
│ ────────────────────────────────────────────────────────────│
│ LAYER 2: SPECIALIST ENGINES                                  │
│ Regulatory Radar · Screening · DocIntel · Vessel Tracking    │
│ ────────────────────────────────────────────────────────────│
│ LAYER 1: 14 CORE MODULES (shared code, ~80%)                 │
│ IAM · TCM · CRM · SRCH · AI · WF · FORM · TASK · COM · DOC   │
│ BILL · BI · AUD · INT                                        │
└──────────────────────────────────────────────────────────────┘
```

### 4.1 Vertical-Specific Logic Packs (Layer 4)

| Vertical | Pack Adds |
|---|---|
| **Immigration** | VEVO monitoring, visa-specific checklists, health-insurance validation, sponsor obligations |
| **Banking (GovernanceX)** | AML pattern detection, TBML risk scoring, SAR management, transaction monitoring rules |
| **Health** | Practitioner credentialing, drug registration, data-residency enforcement, HIPAA/PDPL controls |
| **Tax / VAT** | E-invoicing (ZATCA, MTD), tax-residency tracking, transfer-pricing documentation |
| **Labour** | WPS payroll, Emiratisation/Saudization quotas, work-permit lifecycle |
| **Education** | Accreditation tracking, student-visa linkage, MOE compliance |

---

## 5. EXPANSION MECHANISM (THE "GOD VIEW")

All expansion happens through `app.meru.com` — no code deploys required for the common case.

### 5.1 Adding a Vertical
1. Define industry data models (entities, relationships, lifecycle states).
2. Author a `vertical.json` pack (forms, workflows, roles, KPIs).
3. Register in God UI → version-pin to tenants.

### 5.2 Adding a Country
1. Register regulators (e.g., `UAE-MOHRE`, `KSA-Qiwa`, `AU-HomeAffairs`).
2. Define local compliance rules + data-residency requirements.
3. Add INT-module adapter (if a new gov API).
4. Country JSON inherits + overrides the vertical pack.

### 5.3 Sample Pack Path
```
/packages/config-packs/au/immigration.json
/packages/config-packs/uae/banking.json
/packages/config-packs/ksa/tax.json
```

---

## 6. DESIGN & TECHNICAL RULES (NON-NEGOTIABLE)

### 6.1 UI Standards — "Linear Polish"
- **Stack:** Next.js 15 (App Router), Tailwind 4, shadcn/ui, Geist + Inter fonts.
- **Density:** Minimal whitespace, information-dense but breathable.
- **Motion:** Native micro-interactions only (no heavy animation libraries).
- **Dark mode:** First-class, not an afterthought.

### 6.2 ChatGPT-Style Home Interface
Every staff portal **MUST** lead with a natural-language command bar.
Examples: `"Show my pending cases"`, `"Draft a 482 visa application for John"`, `"Run sanctions check on Acme Corp"`.

### 6.3 RAG-Only AI (Citation Mandate)
- **No free-form generation** for regulatory answers.
- All `GovAI Assistant` responses **MUST** include inline citations to official regulator sources.
- Failure to cite → response is suppressed and falls back to "I don't have a verified source for this."

### 6.4 Strict Multi-Tenancy
- **Row-Level Security (RLS)** is mandatory at the Postgres layer.
- Every table includes `tenant_id`; no query may cross tenants without an explicit "god mode" audit log entry.
- Storage (S3) is bucketed/prefixed per tenant with separate KMS keys for regulated data.

### 6.5 Audit Everything
- Every state-changing action writes to **AUD** with hash-chained tamper-evident logs.
- Logs are WORM (write-once-read-many) and exportable in regulator-friendly formats.

---

## 7. REPOSITORY STRUCTURE

### 7.1 Current State (Phase 1 — this repo, `meru-core`)

Single NestJS backend representing `api.meru.com`. The 14 modules live as NestJS modules under `src/`. The monorepo (apps/ + packages/config-packs + UIs) in §7.2 is the **target**, not the present.

```
meru-core/
├── src/
│   ├── iam/             # IAM — auth, tenants, roles, sessions, API keys
│   ├── tenant/          # (merging into config/ in Phase A)
│   ├── config/          # TCM — config packs, feature flags, supabase config
│   ├── crm/             # CRM — UniversalEntity (polymorphic per CLAUDE.md §2)
│   ├── search/          # (deduping with elasticsearch/ in Phase A)
│   ├── elasticsearch/   # SRCH — Elasticsearch + pgvector hybrid
│   ├── ai/              # AI gateway + 4 specialist engines (engines/)
│   ├── workflow/        # WF — BPMN state machine
│   ├── forms/           # FORM — JSON-schema driven
│   ├── tasks/           # TASK — assignments, recurring jobs
│   ├── notifications/   # COM — multi-channel templates
│   ├── documents/       # DOC — entities, OCR, versioning, metadata
│   ├── storage/         # S3 driver layer (used by documents/)
│   ├── billing/         # BILL — Stripe, usage records, invoices
│   ├── analytics/       # BI — reports, dashboards, executions
│   ├── audit/           # AUD — audit logs (hash-chaining TBD)
│   ├── integrations/    # INT — gov API adapters (entity stub only)
│   ├── queue/           # BullMQ workers
│   ├── orchestration/   # (consolidating with core/ in Phase A)
│   ├── core/            # Cross-cutting filters/interceptors/policies
│   ├── common/          # Shared types
│   ├── migrations/      # TypeORM migrations (squashing in Phase A)
│   └── main.ts / app.module.ts
├── docs/                # ARCHITECTURE / PRD / TRD / STRATEGY / DEVELOPMENT_STRATEGY / DATABASE_SCHEMA / DESIGN_GUIDELINES
├── scripts/             # DB and provisioning scripts (Phase A target)
├── infra/               # Compose, terraform, k8s, github-actions (Phase A target)
└── CLAUDE.md            # This document
```

### 7.2 Target Monorepo Structure (post-Phase B, when UIs land)

```
meru/
├── apps/
│   ├── meru-admin/             # God View UI (app.meru.com)
│   ├── immistack-app/          # Immigration vertical UI
│   └── governance-app/         # Banking GRC vertical UI
│
├── packages/
│   ├── core-api/               # api.meru.com — the 14 modules
│   │   ├── iam/
│   │   ├── tcm/
│   │   ├── crm/
│   │   ├── srch/
│   │   ├── ai/
│   │   ├── wf/
│   │   ├── form/
│   │   ├── task/
│   │   ├── com/
│   │   ├── doc/
│   │   ├── bill/
│   │   ├── bi/
│   │   ├── aud/
│   │   └── int/
│   │
│   ├── engines/                # Specialist engines (cross-vertical)
│   │   ├── regulatory-radar/
│   │   ├── screening/
│   │   ├── doc-intel/
│   │   └── vessel-tracking/
│   │
│   ├── config-packs/           # JSON vertical/country definitions
│   │   ├── _schema/            # JSON-schema validators
│   │   ├── au/
│   │   │   ├── immigration.json
│   │   │   └── tax.json
│   │   ├── uae/
│   │   │   ├── banking.json
│   │   │   └── labour.json
│   │   ├── ksa/
│   │   ├── uk/
│   │   └── ca/
│   │
│   ├── database/               # Drizzle schemas — 216+ normalized tables
│   │   ├── schemas/
│   │   ├── migrations/
│   │   └── rls-policies/
│   │
│   ├── ui/                     # Shared shadcn components & design tokens
│   ├── types/                  # Shared TS types & Zod schemas
│   └── sdk/                    # Vertical-pack SDK for partners
│
├── infra/
│   ├── terraform/
│   ├── k8s/
│   └── github-actions/
│
└── docs/
    ├── CLAUDE.md               # ← this document (vision, rules, agent instructions)
    ├── ARCHITECTURE.md         # System architecture & design
    ├── PRD.md                  # Product requirements
    ├── TRD.md                  # Technical specifications
    ├── STRATEGY.md             # Business & execution strategy
    ├── ADR/                    # Architectural Decision Records
    └── runbooks/
```

---

## 8. TECHNICAL STACK SUMMARY

| Layer | Current (Phase 1) | Target / Future |
|---|---|---|
| **Frontend** | *Not in this repo* | Next.js 15 (App Router), RSC, Tailwind 4, shadcn/ui |
| **API (Backend)** | **NestJS 11** + REST/OpenAPI (Swagger at `/api`) | Same; tRPC added later if a TS-only UI client needs it |
| **Backend Runtime** | Node.js + TypeScript | Same |
| **ORM** | **TypeORM 0.3** (entities + decorators) | Stay on TypeORM unless we hit a wall (decision: see §11.4) |
| **Database** | Postgres (Supabase / RDS) — RLS enforced via migration | Same |
| **Search** | Elasticsearch (`@elastic/elasticsearch` v9) + pgvector | Hybrid BM25 + embeddings |
| **Queue** | BullMQ (`@nestjs/bull`) | Add Temporal only if a workflow truly needs it |
| **Storage** | AWS S3 (`aws-sdk`) — per-tenant prefix; KMS planned | Per-tenant KMS keys for regulated buckets |
| **AI** | Model-agnostic via `langchain` + `openai`; Anthropic next | Add local / regional models per country pack |
| **Auth** | Supabase JWT (primary) + custom Passport strategy; SAML/Local parked | OAuth2 / OIDC, MFA via `otplib`, enterprise SSO via SAML when needed |
| **Observability** | (TBD) — Logger only | OpenTelemetry → Datadog / Grafana |
| **Infra** | Docker Compose (collapsing in Phase A); k8s manifests stubbed | Multi-region per country pack |

**Why TypeORM, not Drizzle?** The codebase has 50+ entities and 11 migrations already in place. The cost of migrating to Drizzle now (~2-4 weeks of pure ORM swap) is not worth it. Decision: stay on TypeORM. Revisit only if RLS composability becomes painful.

---

## 9. THE "BIG PICTURE" GOAL

> **Become the government API layer of the internet.**

By mastering the **Common Corridor** (UAE, KSA, UK, Canada, Australia), Meru achieves:

- **Network effect by regulator:** every new regulator wired in benefits every vertical.
- **Velocity moat:** launching a new vertical (Tax, Health, Education) is **weeks via JSON pack**, not a 12-month custom build.
- **Compliance moat:** every line of code is tenant-isolated, audited, and citation-backed — the regulators themselves trust the platform.

---

## 10. NORTH-STAR METRICS

| Metric | Target |
|---|---|
| Time to launch a new vertical | ≤ 6 weeks |
| Time to onboard a new country | ≤ 3 weeks |
| % of feature code shared across verticals | ≥ 80% |
| AI response citation coverage | 100% |
| Regulatory Radar lag (rule change → draft pack) | ≤ 24 hours |
| Tenant data-isolation incidents | **0 (ever)** |

---

## 11. AGENT INSTRUCTIONS (for Claude / Codex / Cursor)

When working in this repo:

1. **Read this `CLAUDE.md` first.** Always. Before any file edit.
2. **Consult the detailed docs** for specifics: [ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design, [PRD.md](docs/PRD.md) for product scope, [TRD.md](docs/TRD.md) for technical specs, [STRATEGY.md](docs/STRATEGY.md) for business context.
3. **80/20 rule:** if you're tempted to add vertical-specific code into `src/` (any of the 14 NestJS modules), **STOP** — it belongs in a JSON config pack (target: `packages/config-packs/`, scaffolding via `src/config/`) or a future vertical app.
4. **Schema first:** any new entity → start with a TypeORM entity + RLS policy in a migration + DTO with `class-validator` decorators, then wire the service/controller. Update `app.module.ts` `entities[]` array.
5. **Citations or silence:** AI features without citation enforcement do not ship.
6. **One concern per PR:** never mix a core-module change with a vertical-pack change.
7. **Update the relevant ADR** in `docs/ADR/` for any architectural decision.

---

*Last updated: 2026-05-28 — Phase A cleanup pass; current-state §7.1 and stack §8 reconciled with NestJS/TypeORM reality*
*Document owner: Meru Platform Team*
