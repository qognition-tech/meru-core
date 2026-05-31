# Meru RegOS — Business & Execution Strategy

> **Version**: 1.1 | **Status**: Living Document
> **Owner**: Meru Platform Team | **Last Updated**: 2026-05-31
>
> This document defines **how we win** and **how we get there** — the business strategy behind the Meru Regulatory Operating System.
> See also: [ARCHITECTURE.md](./ARCHITECTURE.md) · [PRD.md](./PRD.md) · [TRD.md](./TRD.md)

---

## Table of Contents

1. [Vision & North Star](#1-vision--north-star)
2. [Market Analysis](#2-market-analysis)
3. [Competitive Landscape](#3-competitive-landscape)
4. [Strategic Moats](#4-strategic-moats)
5. [Go-to-Market Strategy](#5-go-to-market-strategy)
6. [Product Roadmap](#6-product-roadmap)
7. [Technical Strategy](#7-technical-strategy)
8. [Team Structure](#8-team-structure)
9. [Pricing & Packaging](#9-pricing--packaging)
10. [Risk Register](#10-risk-register)
11. [Success Criteria](#11-success-criteria)

---

## 1. Vision & North Star

### 1.1 The Mission

> **Become the government API layer of the internet.**

Every country has regulators. Every regulator has forms, filings, checks, and compliance requirements. Every business that touches a regulated industry rebuilds the same plumbing from scratch — identity verification, document management, workflow automation, audit trails, communications, AI assistance.

Meru eliminates this duplication. It provides a **single horizontal engine** that any regulated vertical can plug into via JSON configuration. The result: what took 12-18 months and $500K-$2M to build now takes 6 weeks and a configuration pack.

### 1.2 The North Star

A world where launching a compliant, multi-country regulated service is as fast as launching a Shopify store. Where "government API integration" is no longer a consulting engagement — it's a dropdown menu.

### 1.3 The Three Pillars Revisited

```
┌──────────────────────────────────────────────────────────────┐
│                MERU REGULATORY OS                             │
│                                                               │
│  MERU CORE        IMMISTACK          GOVERNANCEX             │
│  (Engine)         (Immigration)      (Banking GRC)           │
│                                                               │
│  14 Horizontal    4 Portals           15 GRC Modules         │
│  Services         Kanban + Chat       150+ tRPC Routes       │
│  4 AI Engines     AI Command Bar      Finacle Integration    │
│                                                               │
│  ──────────────   ──────────────      ──────────────         │
│  Future Verticals: Health · Tax · Labour · Education         │
│  (each launched via JSON config pack in ≤ 6 weeks)           │
└──────────────────────────────────────────────────────────────┘
```

### 1.4 Why This Matters

Regulatory compliance is a **$300B+ global industry** growing at 8-10% annually. It is almost entirely serviced by:
- **Point solutions** (single vertical, single country)
- **Services firms** (manual labor dressed as technology)
- **In-house builds** (banks spending $5-20M on proprietary compliance platforms)

None of these scale. Meru does.

---

## 2. Market Analysis

### 2.1 The Common Corridor Opportunity

The **Common Corridor** — UAE, KSA, UK, Canada, Australia — represents the world's most active regulatory trade routes. These five countries share:

- **High regulatory velocity**: Frequent rule changes across immigration, banking, tax, and labour
- **Strong economic linkages**: Trade, investment, and talent flows between them
- **Digital government mandates**: All five are investing heavily in e-government APIs
- **English + Arabic operational overlap**: A single platform can serve both language zones
- **Data residency requirements**: Each mandates in-country data storage — a moat against global SaaS

| Country | Key Regulatory Bodies | GDP ($T) | RegTech Market Size |
|---|---|---|---|
| **UAE** | MOHRE, ICP, CBUAE, DHA, FTA | 0.5 | $1.2B (growing 12% YoY) |
| **KSA** | Qiwa, SAMA, SFDA, ZATCA | 1.1 | $1.8B (Vision 2030 accelerating) |
| **UK** | Home Office, FCA, HMRC, CQC | 3.3 | $4.5B (mature, fragmented) |
| **Canada** | IRCC, FINTRAC, CRA, HC | 2.2 | $2.1B (underserved in vertical SaaS) |
| **Australia** | Home Affairs, ASIC, ATO, APRA | 1.7 | $1.9B (strong digital gov APIs) |

### 2.2 TAM / SAM / SOM

| Layer | Definition | Estimate |
|---|---|---|
| **TAM** (Total Addressable Market) | All RegTech spending across all verticals in all countries | $300B+ |
| **SAM** (Serviceable Addressable Market) | RegTech spending in the 6 verticals across the Common Corridor | $12B |
| **SOM** (Serviceable Obtainable Market) | Firms 50-5,000 employees in immigration and banking GRC, Common Corridor, first 3 years | $180M |

### 2.3 Beachhead: Immigration Law Firms

Immigration is the ideal beachhead vertical:

1. **Universally needed**: Every Common Corridor country processes hundreds of thousands of visa applications annually
2. **Document-heavy**: Each application requires 10-40 documents — passports, diplomas, bank statements, medical reports — perfect for Meru's Document Intelligence Layer
3. **Regulatory churn**: Immigration rules change monthly; law firms desperately need the Regulatory Radar
4. **Fragmented market**: No dominant SaaS platform; most firms use a combination of spreadsheets, email, and legacy case management tools
5. **Clear ROI**: Reducing case processing time by 30% directly increases firm revenue

### 2.4 Second Vertical: Banking GRC

GovernanceX targets a different buyer with higher ACV:

1. **Regulatory pressure**: Post-2008, AML/KYC fines exceed $300B globally
2. **Sanctions complexity**: OFAC, EU, UN, UK HMT, and UAE local lists — must be screened continuously
3. **Trade finance**: TBML (Trade-Based Money Laundering) is a $1.6T problem; vessel tracking + document verification is uniquely defensible
4. **Enterprise budgets**: Banks spend $50-500M/year on compliance; a $100K-500K SaaS subscription is a rounding error
5. **Finacle integration**: GovernanceX's native Finacle connector is a moat — no competitor has it

---

## 3. Competitive Landscape

### 3.1 Categories of Competition

```
┌─────────────────────────────────────────────────────────────────┐
│                    COMPETITIVE LANDSCAPE                          │
│                                                                   │
│  HIGH  ┌──────────────┐                    ┌──────────────┐      │
│        │  Point        │                    │  Global       │      │
│  VER  │  Solutions    │     MERU ◀────────▶│  Platforms    │      │
│  TIC  │  (INSZoom,    │     (Platform      │  (Salesforce, │      │
│  AL   │   Clio,       │      Play)          │   ServiceNow) │      │
│  SPE  │   LexisNexis) │                      │               │      │
│  CIF  └──────────────┘                    └──────────────┘      │
│  IC   ┌──────────────┐                    ┌──────────────┐      │
│       │  Services     │                    │  In-House     │      │
│  LOW  │  Firms        │                    │  Builds       │      │
│       │  (Deloitte,   │                    │  (Bank prop.  │      │
│       │   PwC, KPMG)  │                    │   systems)     │      │
│       └──────────────┘                    └──────────────┘      │
│                                                                   │
│            LOW  ◀────── HORIZONTAL BREADTH ──────▶ HIGH         │
│            (Single vertical)          (Cross-vertical)           │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Competitive Analysis by Category

#### Point Solutions (High Vertical Specificity, Low Horizontal Breadth)

| Product | Vertical | Strength | Weakness |
|---|---|---|---|
| INSZoom | Immigration | Deep case types library | No horizontal capability; single-country forms engine |
| Clio | Legal Practice Mgmt | Time tracking + billing | No regulatory intelligence; generic, not compliance-aware |
| LexisNexis Bridger | Sanctions Screening | Data quality, brand trust | Niche product; no workflow, documents, or CRM |
| ComplyAdvantage | AML/KYC | Real-time sanctions data | API-only; no vertical application layer |
| Mitratech | GRC | Enterprise policy management | Heavy, expensive, on-prem legacy |

**Meru advantage vs. point solutions**: We're a platform, not a feature. A firm using INSZoom for immigration + ComplyAdvantage for sanctions pays for two products, two integrations, two data models. A Meru tenant uses one platform that gets smarter with each vertical.

#### Global Platforms (Low Vertical Specificity, High Horizontal Breadth)

| Platform | Threat Level | Analysis |
|---|---|---|
| **Salesforce** | Medium | Financial Services Cloud exists but is generic CRM + compliance add-ons. No Regulatory Radar, no document intelligence, no sanctions screening. Would need to acquire/build all of Meru's engines. |
| **ServiceNow** | Low-Medium | GRC module is IT-governance focused, not regulatory compliance. No vertical-specific AI, no JSON config packs. |
| **SAP GRC** | Low | Enterprise ERP add-on; not a multi-vertical platform. No startup/SMB motion. |

**Meru advantage vs. global platforms**: We're compliance-native, not compliance-as-add-on. Our JSON config model means verticals launch in weeks vs. their 12-month implementation cycles. Our AI is citation-enforced by design, not bolted on.

#### Services Firms (Low Vertical Specificity, Low Horizontal Breadth)

The Big 4 (Deloitte, PwC, KPMG, EY) and regional consultancies dominate compliance spending today. They sell expensive manual work dressed as "advisory."

**Meru advantage vs. services**: Software scales; billable hours don't. A Deloitte team of 20 processing sanctions alerts manually costs $5M/year. Meru's Screening Engine processes 10K names/minute at $0.001/name.

#### In-House Builds (High Horizontal Breadth, Low Vertical Specificity)

Every large bank has a homegrown compliance platform. These are expensive ($5-20M build), fragile (key-person dependencies), and non-portable (can't reuse for new regulations).

**Meru advantage vs. in-house**: Shared infrastructure cost amortized across hundreds of tenants. The Regulatory Radar, once wired into a regulator, benefits every tenant instantly — no bank's in-house team can match that network effect.

### 3.3 The Platform Play

Meru's category is currently empty: **multi-vertical, multi-country, AI-native regulatory operating system**. The question isn't "who competes with Meru" — it's "who could pivot into this space fastest."

The answer: a well-funded AI-native startup, or a Salesforce/ServiceNow acquisition spree. Our moat is **time + regulators**. Each regulator integrated, each config pack published, and each tenant onboarded makes Meru harder to displace.

---

## 4. Strategic Moats

### 4.1 Regulatory Network Effects

This is Meru's strongest and most durable moat.

```
Each new regulator wired into Meru
    ↓
Available to ALL verticals via the Integration Hub
    ↓
Each new vertical benefits from ALL previously integrated regulators
    ↓
Moat deepens with every vertical ← → regulator combination
```

**Example**: When Meru integrates UAE's MOHRE for the Labour vertical, Immigration and Banking get it for free. When UK's Home Office is integrated for Immigration, it's available for Tax and Education. This is a **double-sided network effect** that no single-vertical competitor can replicate.

### 4.2 JSON Config Velocity

Competitors must write code for each vertical × country combination. Meru authors JSON.

| Scenario | Traditional Approach | Meru Approach |
|---|---|---|
| Launch Immigration for UAE | 12-month build, $500K-$1M | 6-week config, $30K |
| Add Canada to Immigration | 3-6 months, custom IRCC integration | 2-week country overlay pack |
| Launch Tax vertical for KSA | 18-month build, $2M | 6-week config, ZATCA adapter reuse |
| Add 5th country | 3-6 months each | 2-3 weeks each (parallel) |

The velocity gap widens over time as more countries and regulators are pre-integrated.

### 4.3 Compliance Trust

Trust is a moat in regulated industries:

1. **Citation-enforced AI**: Every AI response includes inline citations to official regulator sources. No hallucinations, no guesswork.
2. **Hash-chained audit logs**: Every state change is cryptographically verifiable. Regulators can audit with confidence.
3. **RLS-enforced multi-tenancy**: PostgreSQL row-level security at the database layer. No tenant data can leak to another tenant — even if application code has a bug.
4. **Per-tenant KMS keys**: Document encryption with tenant-specific keys. Even Meru operators cannot decrypt tenant documents.

This trust foundation means Meru can eventually seek **regulatory endorsement** — the platform itself being recommended or pre-approved by government bodies.

### 4.4 Data Residency as a Feature

Each Common Corridor country requires in-country data storage. Most SaaS platforms treat this as a burden. Meru treats it as a competitive advantage:

- Multi-region deployment (UAE, KSA, UK, CA, AU data centers)
- Each region runs the full Meru stack locally
- Config packs enforce data residency rules automatically
- Regulators prefer platforms that keep data in-jurisdiction

Competitors who are single-region or who treat multi-region as an afterthought cannot serve the Common Corridor effectively.

### 4.5 AI Data Flywheel

Meru's AI gets smarter with every tenant — without compromising tenant data isolation:

- **Global models** (sanctions screening, OCR, entity extraction) improve from aggregate patterns
- **Tenant-specific fine-tuning** stays within tenant boundaries
- **Citation graph** (regulatory rule → interpretation → application) grows across all verticals
- **Fraud detection patterns** improve from cross-tenant signals (privacy-preserved hashing)

---

## 5. Go-to-Market Strategy

### 5.1 Phase 1: ImmiStack Beachhead (Months 1-12)

**Target**: Immigration law firms in the UAE (50-500 employees)

**Why UAE first**:
- Qognition Agency's home market — relationships, regulatory knowledge, Arabic capability
- High concentration of immigration activity (Dubai alone processes 100K+ visas annually for professionals)
- English + Arabic requirement creates a language barrier that deters Western competitors
- Strong referral culture among law firms

**Channel strategy**:
1. **Direct sales**: 2-person founding sales team targeting top 50 UAE immigration firms
2. **Regulatory partnerships**: Integrate with MOHRE, ICP, GDRFA — then co-market with them
3. **Industry events**: Arab Health, GITEX, STEP Conference
4. **Content**: Publish the "UAE Immigration Compliance Handbook" — become the authoritative source

**Pricing model**: Per-seat SaaS ($50-200/seat/month based on tier), onboarding fee ($5K for configuration, training)

**Target**: 20 firms by month 12 → ~$500K ARR

### 5.2 Phase 2: UAE Expansion + KSA Entry (Months 6-18)

**Overlaps with Phase 1 starting at month 6**

**UAE expansion**:
- Add accounting firms (Tax/VAT vertical MVP)
- Add healthcare credentialing (Health vertical MVP)
- Each new vertical adds $50-100K ARR from existing tenant base expansion

**KSA entry**:
- Hire 1 KSA-based sales lead
- Integrate Qiwa, SAMA, ZATCA regulators
- Leverage UAE case studies and Arabic capability
- Target: 10 KSA immigration firms by month 18

### 5.3 Phase 3: GovernanceX Enterprise (Months 12-24)

**Target**: Mid-tier banks and financial institutions in UAE and KSA

**Why this sequence**:
- Enterprise sales cycles are 6-12 months — start early, close later
- GovernanceX's 95% completeness means it needs integration work, not greenfield build
- ACV for banking is 10-50× higher than immigration (startups vs. banks)

**Channel strategy**:
1. **Finacle partnership**: Co-sell with Infosys Finacle to their banking customers
2. **System integrator partnerships**: Deloitte, Accenture — they sell the implementation, Meru provides the platform
3. **Regulatory events**: Central bank sandbox programs, regulatory sandbox participation
4. **POC → Pilot → Platform**: Start with a single module (Sanctions Screening), expand to full platform

**Pricing model**: Platform fee ($5-25K/month) + per-screened-entity ($0.001-0.01) + implementation ($50-150K)

**Target**: 3 banks by month 24 → ~$1.2M ARR

### 5.4 Phase 4: Common Corridor Expansion (Months 18-36)

| Country | Verticals | Key Regulators | Target ARR (Month 36) |
|---|---|---|---|
| **Canada** | Immigration, Tax | IRCC, CRA, FINTRAC | $400K |
| **UK** | Immigration, Banking | Home Office, FCA, HMRC | $600K |
| **Australia** | Immigration, Education | Home Affairs, ASIC, ATO | $400K |

**Entry strategy**: Partner with 1-2 local firms per country. Use them as reference customers and distribution partners.

### 5.5 Phase 5: Platform Scale (Months 24-48)

- **Self-service onboarding**: Firms can sign up, configure, and go live without human intervention
- **Partner ecosystem**: System integrators, consultants, and ISVs build on Meru's APIs
- **Config pack marketplace**: Third parties publish and sell country/vertical packs
- **Horizontal AI APIs**: Screening, Document Intelligence, and Regulatory Radar sold as standalone APIs

### 5.6 Revenue Projections

| Metric | Year 1 | Year 2 | Year 3 | Year 4 |
|---|---|---|---|---|
| **ImmiStack ARR** | $500K | $1.2M | $2.5M | $4M |
| **GovernanceX ARR** | — | $1.2M | $3M | $6M |
| **Other Verticals ARR** | — | $200K | $800K | $2.5M |
| **Total ARR** | $500K | $2.6M | $6.3M | $12.5M |
| **Customers** | 20 | 45 | 90 | 160 |
| **Avg. ACV** | $25K | $58K | $70K | $78K |

---

## 6. Product Roadmap

### 6.1 18-Month Phased Plan

```
MONTH:  1  2  3  4  5  6  7  8  9  10 11 12 13 14 15 16 17 18
        ├──────────────┼──────────────────┼──────────────────┤
        │  PHASE 1      │  PHASE 2          │  PHASE 3          │
        │  Foundation    │  ImmiStack        │  GovernanceX       │
        │  & Stabilize  │  Launch           │  Integration       │
        ├──────────────┼──────────────────┼──────────────────┤
```

#### Phase 1: Foundation & Stabilize (Months 1-6)

| Milestone | Month | Dependencies |
|---|---|---|
| Meru Core stabilization complete | M1 | All 14 modules passing integration tests |
| Multi-tenancy RLS hardened | M1 | PostgreSQL RLS policies fully tested |
| IAM: SSO + RBAC complete | M2 | SAML integration, role hierarchy |
| Document engine: OCR pipeline working | M2 | S3 abstraction, encryption-at-rest |
| AI gateway: citation enforcement MVP | M3 | Model routing, basic RAG |
| Universal search: hybrid BM25+embeddings | M3 | Elasticsearch + pgvector |
| Workflow engine: BPMN core | M4 | State machine, SLA tracking |
| API stabilization: v1 contracts frozen | M4 | OpenAPI spec published |
| God View MVP (app.meru.com) | M5 | Tenant management, config pack registry |
| **Phase 1 Gate Review** | M6 | All modules green, security audit passed |

#### Phase 2: ImmiStack Launch (Months 4-12, overlaps Phase 1)

| Milestone | Month | Dependencies |
|---|---|---|
| Immigration JSON config pack v1 | M4 | CRM + Workflow + Form modules |
| UAE country overlay pack | M5 | MOHRE, ICP, GDRFA adapters |
| Admin Portal (firm management) | M6 | IAM, TCM, BILL modules |
| Staff Portal (case Kanban + AI command bar) | M7 | TASK, WF, AI modules |
| Client Portal (document upload + case tracking) | M8 | DOC, COM modules |
| Platform Portal (partner dashboard) | M9 | AUD, BI modules |
| VEVO integration (visa verification) | M9 | INT module |
| Onboarding wizard for new firms | M10 | FORM module |
| Production launch — UAE | M11 | All portals + packs |
| KSA country overlay pack | M12 | Qiwa adapter |
| **Phase 2 Gate Review** | M12 | 20 UAE firms live, KSA launch ready |

#### Phase 3: GovernanceX Integration (Months 12-18)

| Milestone | Month | Dependencies |
|---|---|---|
| GovernanceX codebase audit + integration plan | M12 | Architecture doc finalized |
| Screening engine: sanctions matching MVP | M13 | Fuzzy matching algorithms, OFAC/UN/EU lists |
| Banking GRC config pack v1 | M14 | Sanctions, AML, KYC modules |
| Finacle connector (core banking integration) | M14 | INT module, Finacle API docs |
| Trade finance: vessel tracking integration | M15 | Vessel/Asset Tracking Engine, AIS data feeds |
| Document verification (trade docs) | M15 | Document Intelligence Layer |
| RFI (Request for Information) automation | M16 | WF + COM modules |
| AI Command Center (GRC-specific) | M16 | AI module, citation enforcement |
| Pilot with 1 UAE bank | M17 | Full GovernanceX stack |
| **Phase 3 Gate Review** | M18 | 3 banks in pipeline, 1 live |

### 6.2 Beyond 18 Months

| Phase | Timeline | Scope |
|---|---|---|
| **Phase 4** | M18-M24 | Specialist engines go live (Regulatory Radar, Screening at scale), Canada + UK expansion |
| **Phase 5** | M24-M36 | Self-service platform, config pack marketplace, 2 new verticals (Health, Tax) |
| **Phase 6** | M36-M48 | Horizontal AI API products, Australia expansion, partner ecosystem |

---

## 7. Technical Strategy

### 7.1 Monolith-First Philosophy

Meru Core starts as a **modular NestJS monolith** — deliberately, not accidentally.

**Why monolith first (current state)**:
- Single deployable artifact → simpler CI/CD, easier debugging
- Shared TypeORM connection → RLS context propagation is straightforward
- No network boundaries between modules → low latency for cross-module operations
- One codebase → one set of tests, one PR review process
- 17 modules in one process → ~50ms cross-module calls vs. 5-50ms network overhead in microservices

**When to extract (triggers, not timelines)**:
- A module needs independent scaling (e.g., Screening Engine at 10K names/min)
- A module needs a different technology stack (e.g., Python for ML, Rust for performance-critical paths)
- A module has a different deployment cadence (weekly vs. quarterly releases)
- A module has different security boundaries (e.g., Integration Hub facing external gov APIs)
- A module's failure must not cascade (blast-radius isolation)

### 7.2 Extraction Sequence

```
NestJS Monolith (current)
    │
    ├─ First extraction (M12-M18): Specialist Engines
    │   ├── Screening Engine → standalone service (Python/FastAPI)
    │   ├── Document Intelligence Layer → standalone service (Python)
    │   └── Vessel/Asset Tracking → standalone service (Go/Rust)
    │
    ├─ Second extraction (M18-M24): High-load modules
    │   ├── Search → standalone Elasticsearch service
    │   ├── AI Gateway → standalone service (GPU access)
    │   └── Integration Hub → standalone service (gov API rate limiting)
    │
    └─ Third extraction (M24-M36): Domain services
        ├── Workflow Engine → standalone service (Temporal/BullMQ)
        ├── Billing → standalone service (Stripe integration)
        └── Analytics → standalone service (OLAP queries)
```

**What stays in the monolith**: IAM, CRM, TCM, TASK, FORM, COM, AUD — these are tightly coupled by design and don't benefit from distribution.

### 7.3 The JSON-Pack Abstraction

The JSON config pack system is Meru's most important technical bet. It must be:

1. **Schema-validated**: Every pack validates against a versioned JSON Schema (`packages/config-packs/_schema/`)
2. **Version-pinned**: Each tenant pins to a specific pack version. Upgrades are opt-in with rollback.
3. **Merge-layered**: Country packs layer on top of vertical packs. `uae/immigration.json` overrides defaults in `immigration_base.json`.
4. **Diffable**: The Regulatory Radar proposes pack changes as JSON diffs → PR → human review → merge → publish.
5. **Hot-reloadable**: Packs update without server restart. New rules take effect on next request.

```
Vertical Base Pack (immigration_base.json)
    │
    ├── Country Overlay: UAE (uae/immigration.json)
    │   └── Adds: MOHRE validation rules, ICP document requirements
    │
    ├── Country Overlay: KSA (ksa/immigration.json)
    │   └── Adds: Qiwa integration, Saudization checks
    │
    └── Country Overlay: CA (ca/immigration.json)
        └── Adds: IRCC forms, French language support
```

### 7.4 Infrastructure Strategy

| Stage | Infrastructure | Rationale |
|---|---|---|
| **Phase 1-2** (Current-12mo) | Docker Compose on bare metal / VPS | Simple, fast iteration, no DevOps overhead |
| **Phase 2-3** (M6-M18) | Managed Kubernetes (GKE/EKS) per region | Auto-scaling, rolling deploys, health checks |
| **Phase 4+** (M18+) | Multi-region K8s + Terraform | Infrastructure-as-code, disaster recovery, compliance certifications |

**Data residency from day one**: Even in Docker Compose, each region gets its own Postgres instance. No cross-region data replication without explicit tenant opt-in.

### 7.5 Technology Bets

| Bet | Rationale | Risk |
|---|---|---|
| **Postgres + RLS** vs. application-level tenancy | Database-enforced isolation; no app-level leak possible | RLS complexity for complex queries |
| **TypeORM** (current) → **Drizzle** (target) | TypeORM is mature; Drizzle is more TypeScript-native and RLS-friendly | Migration effort |
| **tRPC** (internal) + **REST** (external) | tRPC gives end-to-end type safety; REST enables partner integrations | Maintaining two API surfaces |
| **Model-agnostic AI gateway** | No vendor lock-in; route to cheapest/best model per request | Abstraction overhead |
| **Elasticsearch + pgvector** (hybrid) | BM25 for keyword search, embeddings for semantic; best of both | Operational complexity |

---

## 8. Team Structure

### 8.1 Founding Team (Year 1)

| Role | Headcount | Responsibilities |
|---|---|---|
| **CTO / Tech Lead** | 1 | Architecture, code review, technical decisions, DevOps |
| **Full-Stack Engineers** | 3 | Meru Core modules, frontend portals, config packs |
| **AI/ML Engineer** | 1 | AI gateway, citation enforcement, screening algorithms, OCR pipeline |
| **Product Designer** | 1 | UI/UX across all portals, design system, Linear polish |
| **Product Manager** | 1 | Requirements, backlog, user research, stakeholder communication |
| **Domain Expert (Immigration)** | 1 (part-time) | UAE immigration process knowledge, regulatory relationships |
| **Sales / BD (UAE)** | 1 | Direct sales to immigration firms, partnership development |
| **Total** | **8 (+1 PT)** | |

### 8.2 Hiring Sequence

```
Month 1-2:     CTO + 1 Full-Stack + Product Designer
Month 2-3:     +1 Full-Stack + Product Manager
Month 3-4:     +1 Full-Stack + AI/ML Engineer
Month 4-6:     +Domain Expert (Immigration) + Sales/BD
Month 6-12:    +2 Full-Stack (ImmiStack portals), +1 DevOps
Month 12-18:   +2 Full-Stack (GovernanceX), +1 Domain Expert (Banking), +1 Sales (KSA)
```

### 8.3 Team Structure (Year 2)

```
                        ┌─────────────┐
                        │  CEO/Founder │
                        └──────┬──────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                 │
     ┌────────▼──────┐ ┌──────▼──────┐ ┌───────▼──────┐
     │  Engineering   │ │  Product    │ │  GTM / Sales  │
     │  (CTO)         │ │  (PM)       │ │  (Head of BD) │
     └───────┬────────┘ └──────┬──────┘ └──────┬───────┘
             │                 │                │
    ┌────────┼────────┐        │                │
    │        │        │        │                │
┌───▼──┐ ┌──▼──┐ ┌───▼───┐    │                │
│Core  │ │AI/ML│ │Frontend│    │                │
│Team  │ │Team │ │Team    │    │                │
│(3 FE)│ │(2)  │ │(2 FE)  │    │                │
└──────┘ └─────┘ └────────┘    │                │
```

### 8.4 Key Hires by Urgency

1. **CTO / Tech Lead** — architecture ownership, can't proceed without
2. **Product Designer** — all portals need design before engineering
3. **Full-Stack Engineers** — building velocity
4. **AI/ML Engineer** — core differentiator, can't outsource
5. **Domain Expert (Immigration)** — process knowledge, regulatory relationships
6. **Sales/BD** — revenue, customer feedback loop

### 8.5 Culture Principles

- **Ship to learn**: A working prototype with 3 real users teaches more than 6 months of planning
- **80/20 relentlessly**: Every feature must serve 80% of tenants. The 20% belongs in a config pack.
- **Citations or silence**: AI answers without citations don't ship. Period.
- **Linear polish**: UI density over whitespace, dark mode first-class, micro-interactions only
- **No tenant data leakage**: Reviews, tests, and audits enforce this. One incident is existential.

---

## 9. Pricing & Packaging

### 9.1 Pricing Architecture

```
Total Price = Platform Fee + Vertical Pack(s) + Country Pack(s) + Usage

┌────────────────────────────────────────────────────┐
│  USAGE-BASED                                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│  │ AI Tokens│ │ Doc OCR  │ │Screening │  ...       │
│  │ $/1K tok │ │ $/page   │ │ $/name   │           │
│  └──────────┘ └──────────┘ └──────────┘           │
├────────────────────────────────────────────────────┤
│  COUNTRY PACKS                                      │
│  UAE ($200/mo) · KSA ($200/mo) · UK ($300/mo)     │
│  CA ($300/mo) · AU ($300/mo)                       │
├────────────────────────────────────────────────────┤
│  VERTICAL PACKS                                     │
│  Immigration ($500/mo) · Banking ($1,500/mo)       │
│  Health ($800/mo) · Tax ($600/mo)                  │
├────────────────────────────────────────────────────┤
│  PLATFORM (per seat)                                │
│  Free (3 users) · Starter ($50/seat) · Pro ($100)  │
│  Professional ($150) · Enterprise (custom)          │
└────────────────────────────────────────────────────┘
```

### 9.2 Platform Tiers

| Tier | Price | Users | Includes |
|---|---|---|---|
| **Free** | $0/mo | 3 | 1 vertical pack, 1 country pack, 5GB storage, community support |
| **Starter** | $50/seat/mo | 3-20 | 1 vertical pack, 2 country packs, 50GB storage, email support |
| **Professional** | $100/seat/mo | 10-100 | 2 vertical packs, 3 country packs, 250GB storage, priority support, SSO |
| **Enterprise** | $150/seat/mo (custom) | 50+ | Unlimited vertical/country packs, 1TB+ storage, dedicated support, SLA, on-prem option |

### 9.3 Usage-Based Add-Ons

| Meter | Unit | Rate | Notes |
|---|---|---|---|
| **AI Tokens** | Per 1K tokens | $0.02 (input), $0.06 (output) | Pass-through + margin |
| **Document OCR** | Per page | $0.05 | First 1,000 pages/mo free per tenant |
| **Sanctions Screening** | Per name screened | $0.001 | Batch pricing: $0.0005/name over 100K/mo |
| **Vessel Tracking** | Per vessel/day | $0.10 | AIS data pass-through |
| **SMS Notifications** | Per message | Pass-through (Twilio rate) | |
| **Storage Overage** | Per GB/mo | $0.10 | Over included tier limit |

### 9.4 Enterprise Pricing (GovernanceX)

Banks don't buy per-seat SaaS. Enterprise deals are structured as:

| Component | Range | Notes |
|---|---|---|
| **Annual Platform Fee** | $60K-300K | Based on modules used, transaction volume |
| **Implementation** | $50K-150K | One-time: Finacle integration, data migration, training |
| **Ongoing Support** | 20% of platform fee | SLA-backed, dedicated support engineer |
| **Usage (screening)** | $0.0005-0.001/name | Volume discounts at 1M+ names/month |

### 9.5 Competitive Pricing Comparison

| Product | Starting Price | What You Get |
|---|---|---|
| INSZoom | $100-200/user/mo | Immigration case management only |
| ComplyAdvantage | $500-5K/mo + per-check | Sanctions screening API only |
| Clio | $39-129/user/mo | Legal practice management (no compliance) |
| **Meru (Immigration, Professional)** | **$100/user/mo** | Full platform: CRM + Docs + AI + Workflows + Comms |
| **Meru (Banking, Enterprise)** | **$5-25K/mo** | All modules + Screening + Vessel Tracking + Finacle |

**Value proposition**: Meru costs the same as a single point solution but delivers the full platform. Once a tenant adds a second vertical or country, the value of the integrated platform becomes impossible to match with point-solution stitching.

---

## 10. Risk Register

### 10.1 Technical Risks

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| **Multi-tenancy data breach** | Critical | Low | PostgreSQL RLS at database layer; per-tenant KMS keys; automated tenant-isolation tests in CI; quarterly third-party penetration tests |
| **AI hallucination in regulatory context** | High | Medium | Citation enforcement at gateway level; "I don't know" fallback; no AI output shown without source link; human review for high-stakes domains |
| **RLS performance degradation at scale** | Medium | Medium | Query optimization per tenant pattern; connection pooling tuned per tenant; pg_stat_statements monitoring; extraction path defined if needed |
| **TypeORM → Drizzle migration complexity** | Medium | High | Phased migration (new tables in Drizzle, existing in TypeORM during transition); dual-schema connection pool during migration window |
| **OCR accuracy below threshold for Arabic docs** | Medium | Medium | Multi-model ensemble (Tesseract + Azure + Google Vision); human-in-the-loop for low-confidence results; continuous accuracy benchmarking per language |
| **Sanctions list sync latency** | High | Low | Multi-source redundancy (direct API + file download + third-party aggregator); cached lists with TTL < 1 hour; alert if sync fails |
| **Specialist engine extraction complexity** | Medium | Medium | Define clear API contracts before extraction; run monolith + extracted service in parallel during transition; feature flags to toggle between implementations |

### 10.2 Market Risks

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| **Well-funded competitor enters RegOS space** | High | Medium | Move fast in Common Corridor; build regulatory integrations that can't be replicated quickly; cultivate deep customer relationships and switching costs |
| **Regulatory change invalidates JSON pack model** | Medium | Low | JSON packs are version-pinned; Regulatory Radar detects changes within 24 hours; packs are diffable and mergeable |
| **Single-country dependency (UAE beachhead)** | Medium | Medium | KSA entry by M12, UK/CA by M18; no single country > 40% of revenue |
| **Vertical concentration (Immigration only)** | Medium | High (Y1) | GovernanceX integration starts M12; Health/Tax MVP by M18; no single vertical > 50% of revenue by Y2 |
| **Economic downturn reduces compliance spending** | Low | Medium | Compliance is counter-cyclical — regulatory pressure doesn't decrease in downturns; platform saves money vs. manual processes |

### 10.3 Execution Risks

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| **Cannot hire senior engineers fast enough** | High | High | Remote-first hiring; competitive equity; build in public (open-source core modules, developer content); leverage AI-assisted development |
| **GovernanceX integration complexity underestimated** | Medium | Medium | Start with single module (Sanctions Screening); incremental integration; maintain standalone operation during transition |
| **Founder context bottleneck** | High | Medium | CLAUDE.md as source of truth; all architectural decisions documented in ADRs; hire CTO as first engineering hire |
| **Multi-country regulatory integration slows velocity** | Medium | High | Integration Hub adapter pattern standardizes gov API connections; prioritize regulators by tenant demand; most regulators use similar REST patterns |
| **Sales cycle length for enterprise banking** | Medium | High | Start with mid-tier banks (shorter cycles); use POC → pilot → platform approach; leverage Finacle partnership for warm intros |
| **Cash runway insufficient for 18-month plan** | High | Medium | Revenue from M6 (early ImmiStack customers); lean team (8 people Y1); prioritize paid pilots; consider strategic angel/pre-seed at M12 |

### 10.4 Risk Heat Map

```
LIKELIHOOD
  HIGH  │  TypeORM→Drizzle  │  Hiring velocity    │
        │  Vertical conc.   │  Gov API velocity   │
        │                   │  Founder bottleneck │
  ──────┼──────────────────┼─────────────────────┤
  MED   │  AI hallucination │  Competitor entry   │  Cash runway
        │  OCR accuracy     │  Single-country     │
        │  GovX complexity  │                     │
  ──────┼──────────────────┼─────────────────────┤
  LOW   │  Sanctions sync   │  RLS performance    │
        │  Reg change risk  │  Extraction complex.│
        │  Econ. downturn   │                     │
        └──────────────────┴─────────────────────┘
            LOW                   MED                HIGH
                            SEVERITY
```

---

## 11. Success Criteria

### 11.1 Phase-Gate Metrics

#### Phase 1 Gate (Month 6) — "Stable Foundation"

| Metric | Target | Measurement |
|---|---|---|
| All 14 core modules operational | 14/14 | Integration test suite passing |
| API test coverage | ≥ 80% | Jest coverage report |
| Multi-tenancy RLS tests passing | 30/30 scenarios | Dedicated RLS test suite |
| API response time (p95) | < 200ms | Prometheus/Grafana |
| Security audit | 0 critical, 0 high findings | Third-party pentest |
| Docker Compose deploy time | < 5 minutes | CI/CD pipeline |

#### Phase 2 Gate (Month 12) — "ImmiStack Live"

| Metric | Target | Measurement |
|---|---|---|
| Paying UAE immigration firms | ≥ 20 | Stripe dashboard |
| Monthly active users | ≥ 200 | Analytics |
| Cases processed through platform | ≥ 1,000 | Database query |
| Client NPS | ≥ 40 | Survey |
| Platform uptime | ≥ 99.5% | Uptime monitoring |
| KSA country pack validated | 1 pilot firm | Customer interview |
| Time to onboard new firm | < 2 weeks | Onboarding tracker |

#### Phase 3 Gate (Month 18) — "GovernanceX Integrated"

| Metric | Target | Measurement |
|---|---|---|
| Banks in pipeline | ≥ 3 | CRM |
| Banks live | ≥ 1 | Stripe dashboard |
| Sanctions screening accuracy | ≥ 99.5% recall, ≥ 95% precision | Benchmark dataset |
| Screening speed (batch) | ≥ 10K names/min | Load test |
| Finacle connector operational | Production deployment | Integration test |
| Document fraud detection accuracy | ≥ 90% precision | Benchmark dataset |

### 11.2 Launch Readiness Checklist

#### ImmiStack Launch (Month 11)

- [ ] Production infrastructure provisioned (UAE region)
- [ ] SSL certificates deployed
- [ ] Database backups configured (hourly incremental, daily full)
- [ ] Monitoring and alerting configured (Datadog/Grafana)
- [ ] Incident response runbook documented
- [ ] Data residency compliance verified (UAE data in UAE region)
- [ ] Load test: 500 concurrent users, < 200ms p95
- [ ] Security: penetration test completed, findings resolved
- [ ] Legal: Terms of Service, Privacy Policy, DPA published
- [ ] Support: help desk configured, SLAs defined
- [ ] Onboarding: documentation + wizard tested with 3 design partners
- [ ] Billing: Stripe integration tested with real transactions
- [ ] Backup: disaster recovery plan documented and tested

#### GovernanceX Pilot (Month 17)

- [ ] All ImmiStack launch criteria met
- [ ] Finacle sandbox integration tested
- [ ] Sanctions list sync verified for all required lists
- [ ] Vessel tracking AIS data feed operational
- [ ] Document fraud detection model validated
- [ ] Banking-specific compliance review completed
- [ ] Pilot agreement signed with bank partner
- [ ] Data isolation verified between immigration and banking tenants

### 11.3 Customer Validation Milestones

| Milestone | Target Date | Validation |
|---|---|---|
| 5 design partners actively using ImmiStack | M5 | Weekly feedback calls |
| First paid customer (any tier) | M6 | Revenue in Stripe |
| First customer referral (customer → new lead) | M9 | CRM attribution |
| First 50-seat customer | M10 | Contract signed |
| First customer with 2+ vertical packs | M18 | Revenue report |
| First enterprise banking deal closed | M18 | Contract signed |
| Net revenue retention > 100% | M18 | Revenue analysis |

### 11.4 North-Star Metrics (Long-Term)

These are the CLAUDE.md metrics, repeated here as the ultimate success criteria:

| Metric | Target | Current Status |
|---|---|---|
| Time to launch a new vertical | ≤ 6 weeks | N/A (first vertical in progress) |
| Time to onboard a new country | ≤ 3 weeks | N/A |
| % of feature code shared across verticals | ≥ 80% | 100% (only 1 vertical so far) |
| AI response citation coverage | 100% | Not yet implemented |
| Regulatory Radar lag (rule change → draft pack) | ≤ 24 hours | Not yet implemented |
| Tenant data-isolation incidents | **0 (ever)** | 0 |

### 11.5 When We Know We're Winning

1. **A firm switches from a point solution to Meru** — not from nothing, but from an incumbent
2. **A customer expands from 1 vertical to 2** — the platform effect is working
3. **A regulator recommends Meru** — compliance trust achieved
4. **A partner builds on Meru's APIs without our involvement** — platform, not product
5. **JSON config pack contributed by a third party** — ecosystem forming
6. **A competitor tries to copy the JSON pack model** — validation of the architecture

---

*Last updated: 2026-05-28*
*Document owner: Meru Platform Team*
*Next review: 2026-08-28 (quarterly)*
