# Meru RegOS — Product Requirements Document

> **Version**: 1.1 | **Status**: Target State — Phase A/B/C implementation complete
> **Owner**: Meru Platform Team | **Last Updated**: 2026-05-31
>
> This document defines **what** we're building and **why** — for engineering, product, sales, and investors.
> See also: [ARCHITECTURE.md](./ARCHITECTURE.md) · [TRD.md](./TRD.md) · [STRATEGY.md](./STRATEGY.md)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Target Users & Personas](#2-target-users--personas)
3. [Meru Core — Platform Engine Features](#3-meru-core--platform-engine-features)
4. [Vertical: ImmiStack (Immigration)](#4-vertical-immistack-immigration)
5. [Vertical: GovernanceX (Banking GRC)](#5-vertical-governancex-banking-grc)
6. [Common Corridor Strategy](#6-common-corridor-strategy)
7. [User Journeys](#7-user-journeys)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Release Phases](#9-release-phases)
10. [Success Metrics](#10-success-metrics)

---

## 1. Executive Summary

### 1.1 The Problem

Every regulated industry — immigration law, banking compliance, healthcare credentialing, tax filing — builds the same software from scratch. A 50-person immigration law firm and a 5,000-person bank both need: identity management, document storage, workflow automation, communications tracking, audit logging, and AI assistance. Yet there is **no horizontal platform** that provides these as a shared engine.

The result: $500K–$2M and 12–18 months to launch a vertical SaaS product. Every new country adds 6 months. Every new regulation triggers a fire drill.

### 1.2 The Solution

**Meru is a Regulatory Operating System (RegOS).** It provides 80% of the compliance infrastructure as a shared horizontal engine. The remaining 20% — the vertical-specific logic — is injected as JSON configuration packs per industry and country.

| Metric | Without Meru | With Meru |
|---|---|---|
| Time to launch new vertical | 12–18 months | ≤ 6 weeks |
| Time to add new country | 3–6 months | ≤ 3 weeks |
| % of code shared across verticals | 0% | ≥ 80% |
| Per-vertical engineering team needed | 4–6 engineers | 1–2 engineers |

### 1.3 The Three Pillars

1. **Meru Core** — The horizontal engine: 14 shared modules + 4 specialist AI engines
2. **ImmiStack** — Immigration vertical: 4 portals (Admin, Staff, Client, Platform)
3. **GovernanceX** — Banking GRC vertical: Sanctions screening, AML, Trade Finance compliance

Future verticals: Health, Tax/VAT, Labour, Education — each launched via JSON pack in weeks, not years.

### 1.4 Competitive Moat

- **Regulatory network effect**: Each new regulator wired into Meru benefits every vertical. Once the UAE's MOHRE is integrated for Labour, it's available for Immigration and Banking too.
- **JSON config velocity**: Competitors must write code for each vertical/country combination. Meru authors JSON.
- **Compliance trust**: Every action is hash-chain audited, every AI answer is citation-enforced, every tenant is RLS-isolated. Regulators trust the platform.
- **Common Corridor mastery**: UAE, KSA, UK, Canada, Australia — the world's most active regulatory corridors — are the beachhead.

---

## 2. Target Users & Personas

### Persona 1: Platform Operator (Meru Employee)
- **Role**: `platform_admin`
- **Goals**: Monitor tenant health, manage feature flags, publish config packs, oversee billing
- **Portal**: Platform Portal (God View at `app.meru.com`)
- **Key actions**: View global MRR, suspend/upgrade tenants, toggle modules per tenant, approve config pack PRs from Regulatory Radar

### Persona 2: Firm Administrator
- **Role**: `firm_admin`
- **Goals**: Run their immigration/legal/accounting firm — manage staff, billing, branding, settings
- **Portal**: Admin Portal
- **Key actions**: Invite staff, set permissions, configure payment gateways, upload firm branding, view analytics

### Persona 3: Staff / Case Officer
- **Role**: `agent`, `senior_agent`
- **Goals**: Process cases efficiently — manage tasks, communicate with clients, upload documents
- **Portal**: Staff Portal
- **Key actions**: View Kanban board, process visa applications (immigration) or compliance checks (banking), send communications, create file notes

### Persona 4: End Client / Applicant
- **Role**: `client`
- **Goals**: Track case progress, submit documents, make payments, communicate with their agent
- **Portal**: Client Portal
- **Key actions**: View case timeline, upload required documents, pay invoices, message case officer

### Persona 5: Regulator / Auditor
- **Role**: External, read-only access
- **Goals**: Verify compliance, export audit logs, review case files
- **Access**: Time-limited, read-only audit portal with export capabilities

---

## 3. Meru Core — Platform Engine Features

These are the 14 platform modules that every vertical inherits.

### Module Feature Summary

| Module | What It Provides |
|---|---|
| **IAM** | Login, registration, JWT/SAML SSO, RBAC roles, MFA, user provisioning |
| **TCM** | Tenant settings, config pack validation, module enable/disable, version pinning |
| **CRM** | Universal entity storage (person/organization), relationship graph, vertical attributes |
| **SRCH** | Full-text search, vector semantic search, faceted filtering |
| **AI** | AI chat, entity analysis, document extraction, form validation, compliance risk assessment |
| **WF** | BPMN workflow engine, SLA tracking, escalations, state machines |
| **FORM** | JSON Schema form builder, conditional fields, submission management |
| **TASK** | Task CRUD, assignments, priorities, due dates, recurring jobs |
| **COM** | Multi-channel messaging (email, WhatsApp, SMS, push), templates, preferences |
| **DOC** | Document upload, versioning, S3 storage, OCR extraction, RBAC, encryption |
| **BILL** | Subscription plans, usage-based billing, invoicing, credit ledger |
| **BI** | Dashboards, KPI cards, scheduled reports, CSV/PDF export |
| **AUD** | Tamper-evident audit logging, hash-chained, WORM, compliance standard tagging |
| **INT** | Government API adapters, rate-limited, retry/backoff |

### Platform-Level (God View) Features

- **Tenant Management**: View all tenants across all verticals with health status, MRR, case counts, staff counts, last activity
- **Feature Flags**: Toggle features per tenant or globally; A/B test management
- **Module Adoption Analytics**: Which modules are most used, country module usage map
- **Config Pack Publishing**: Approve and version-pin vertical/country config packs
- **Global Search**: Cross-tenant search for platform support (with audit log entry)
- **Tenant Impersonation**: Support access with full audit trail

---

## 4. Vertical: ImmiStack (Immigration)

### 4.1 Overview

ImmiStack is a multi-tenant SaaS platform for immigration law firms and agencies. The product has **four portals** serving different user types.

### 4.2 Admin Portal Features

#### Dashboard
- KPI cards: Total Active Cases, Revenue (MTD), Pending Documents, Lead Conversion Rate
- Revenue trend area chart with sparklines
- Case status overview bar chart
- Staff performance leaderboard table
- Upcoming deadlines (next 7 days)
- Recent activity feed

#### AI Command Interface (ChatGPT-Style Home)
- Centered chat input: "Ask anything or give a command..."
- Suggestion chips: "Today's summary", "Pending cases", "Missing documents", "Overdue payments"
- AI responses displayed as structured cards (data tables, stat cards, charts)
- Streaming responses via `POST /api/v1/ai/chat`
- Sidebar auto-collapses when chat is active
- Quick action buttons: "New Case", "New Lead", "Upload Docs"

#### CRM — Clients & Leads
- **Leads Page**: Split-view (list + detail panel), lead scoring (0-100 AI-generated), source attribution, status pipeline (New → Contacted → Qualified → Converted → Lost)
- **Clients Page**: Card grid or table view, filters by visa type/country/staff/payment status, client detail with 360° view
- **Client Detail**: Case progress timeline, document hub, payment history, communications thread, forms, activity log
- **Case Detail Workbench**: Two-column layout — left (65%): stage stepper, application details accordion, document checklist, draft preview; right (35%): staff assignment, payment widget, task list, communications

#### Kanban Task Board
- Dynamic columns from workflow engine (Lead → Consultation → Signed Up → Documents Pending → Application Draft → Client Review → Submitted → Additional Info → Granted/Refused)
- Drag-and-drop with `@dnd-kit/core`, optimistic updates, `PATCH /api/v1/cases/{id}/stage`
- Card design: client avatar, visa type badge, case ID, country flag, assignee, due date, document completeness bar, priority dot
- Views: Kanban (default), List (table), Calendar (monthly grid)
- Filters: Assignee, Priority, Visa Type, Country, Due Date range

#### Document Hub
- Two-panel: folder tree (left) + document grid (right)
- Grid/list toggle, status badges (Verified, Pending Review, Rejected, Expiring, Expired)
- Drag-and-drop upload zone with multi-file support and progress bars
- Visa-specific document checklists (dynamically generated from visa type)
- Document request flow: Staff requests → Client uploads → Staff reviews → Approve/Reject
- Expiry alerts dashboard: visa, passport, health insurance with configurable warning periods

#### Payments Module
- Summary cards: Total Collected (MTD), Outstanding, Overdue, Government Fees Pending
- Tabs: Client Payments, Government Fees
- EMI schedule view (expandable per case)
- Invoice system: 3 templates (Minimal, Professional, Classic) with firm branding, PDF generation
- Online payment link generation (Stripe), QR code option
- Manual payment recording with receipt upload

#### Communications Hub
- Three-panel layout (like a desktop email client): channel filter | conversation list | thread
- Multi-channel: Email, WhatsApp, SMS, Internal Notes
- AI draft button: generates message from case context
- Template selector for common responses
- File Note toggle: marks message as compliance-relevant (immutable, timestamped)
- WhatsApp delivery receipts (sent ✓, delivered ✓✓, read ✓✓)

#### Settings & Branding
- **Branding**: Logo upload, color picker, "Extract from website URL" AI feature, invoice template preview, email template editor, client portal theme (Light/Dark/System/Custom)
- **Modules**: Toggle country modules, view usage stats and pricing
- **Integrations**: Google Drive, Gmail, Calendar, WhatsApp Business API, Stripe, HubSpot, Zoho, Mailchimp
- **Team & Roles**: Staff table, role editor with permission matrix, invite flow, country/visa type access control

#### Analytics
- Revenue over time (area chart), revenue by visa type (bar chart), MoM growth
- Cases by stage (stacked bar), average time per stage (horizontal bar), success/refusal rate (donut)
- Lead conversion funnel, lead source breakdown (pie), lead-to-client time (line)
- Staff performance: cases completed, avg case duration, document request response time
- Export: PDF report + CSV data

### 4.3 Staff Portal Features

- **AI Home**: Scoped to "My tasks today", "Cases needing action", "Pending document requests"
- **My Cases Kanban**: Same full Kanban component, pre-filtered to assigned cases
- **Case Processing**: Full case detail with limited permissions (can update stage, upload docs, create tasks, send communications, cannot change billing or staff assignment)
- **Calendar**: Staff calendar with Google Calendar sync

### 4.4 Client Portal Features

- **Home**: Case status card, progress bar, next action box ("ACTION REQUIRED: Upload bank statements by Mar 25"), case timeline (past → current → future stages)
- **Documents**: Visa-specific checklist with upload buttons, My Documents list with status (Submitted/Under Review/Approved/Rejected)
- **Payments**: Outstanding balance card, payment history, Pay Now button, invoice download
- **Messages**: Chat interface with case officer, file attachments, read receipts
- **Draft Review**: Application draft viewer, field-by-field review, correction request form, approval button
- **Profile**: Personal info, contact details, notification preferences, security settings

### 4.5 Onboarding Wizard (7 Steps)

1. **Firm Profile**: Name, operating countries, firm size, contact email/phone
2. **Country Configuration**: Per-country staff count, visa categories, expected volume
3. **Data Migration**: Existing data? CSV upload, HubSpot/Zoho/Salesforce OAuth, manual entry
4. **Payments Configuration**: Online/Offline/Hybrid, EMI toggle, currency, gateway selection
5. **Document Storage**: Google Drive, AWS S3, Azure Blob, or Platform-managed
6. **Branding Setup** (Optional): Logo, colors, email template, invoice template
7. **Module Selection**: Core modules (always on) + optional paid modules with live pricing calculator

### 4.6 Immigration-Specific Features

- **VEVO Monitoring** (Australia): Automated visa status checks against Department of Home Affairs
- **Visa-Specific Checklists**: Dynamic document requirements per visa type (Student: CoE, financials, English test, health insurance; 482: skills assessment, sponsorship, English; etc.)
- **Health Insurance Validation**: Automated expiry tracking and coverage verification
- **APF (Application Processing Fee) Tracking**: Government fee payment tracking per case
- **Sponsor Obligations Monitoring**: For employer-sponsored visas
- **Country Modules**: Australia (VEVO), Canada (IRCC integration), UK (Home Office), New Zealand (INZ)

---

## 5. Vertical: GovernanceX (Banking GRC)

### 5.1 Overview

GovernanceX is a modular Governance, Risk, and Compliance platform for banks, fintechs, and financial institutions. It comprises **15 major modules** covering sanctions screening, AML, trade finance compliance, and regulatory reporting.

### 5.2 Module Feature Summary

#### Module 1: Sanctions Screening & Counterparty Due Diligence
- Real-time screening against OFAC, EU, UN, UK HMT, UAE Local lists
- Fuzzy logic matching: Levenshtein, Jaro-Winkler, Soundex, transliteration normalization (Arabic ↔ Latin)
- World-Check One and Dow Jones Risk & Compliance integration
- Scheduled batch rescreening (configurable: daily, weekly, monthly)
- Bulk import via CSV/Excel
- Sanctions list auto-sync every 24 hours
- PEP (Politically Exposed Persons) identification
- Adverse media monitoring with AI sentiment analysis

#### Module 2: Document Verification & Fraud Detection
- AI-powered document authenticity verification
- Fraud pattern detection: EXIF analysis, font inconsistency, metadata tampering
- Cross-tenant duplicate detection (privacy-preserving perceptual hash comparison)
- Multi-language OCR: Arabic, English, Urdu, Tagalog, Hindi
- Layout-aware extraction: passports, payslips, bank statements, contracts, bills of lading
- Batch document processing
- Document annotations and versioning

#### Module 3: Trade Finance & Vessel Tracking
- TBML (Trade-Based Money Laundering) risk scoring
- Price benchmark analysis: over/under-invoicing detection
- Real-time AIS vessel tracking with geofencing
- Sanctioned-port detection
- Dark fleet detection (AIS transmission gaps)
- Ship-to-ship transfer risk alerts
- ML-based anomalous trade pattern detection
- Vessel ownership chain analysis

#### Module 4: RFI (Request for Information) Automation
- AI trigger detection: automatically identifies when additional docs are needed
- Automatic case generation from screening hits
- Email automation with configurable templates
- A/B testing for email templates
- Response tracking with SLA monitoring
- AI validation of submitted documents

#### Module 5: AI Command Center
- **5 specialized AI agents**: Regulatory Intelligence, Risk Assessment, Control Testing, Vendor Due Diligence, Compliance Monitoring
- Human-in-the-loop approval workflows
- Task orchestration across agents
- Agent analytics and performance tracking

#### Module 6: Finacle Core Banking Integration
- Real-time transaction sync via SOAP/REST APIs
- Customer data sync with conflict resolution
- Account information retrieval
- Turnover monitoring and breach detection
- OAuth 2.0 authentication
- Sandbox testing environment

#### Module 7: Compliance Tracker
- Multi-framework support: Basel III, AML/CFT, IFRS, GDPR, PCI DSS
- Deadline management with configurable advance warnings
- Breach detection and remediation tracking
- Regulatory reporting generation

#### Module 8: Task Registry & Workflow Management
- Centralized governance tasks with priority/assignment/deadline
- BPMN-like workflow engine
- Dependency tracking between tasks
- Full audit trail

#### Module 9: Stakeholder Management
- Contact directory with role-based organization
- Communication logging
- Meeting management with minutes
- Escalation paths

#### Module 10: Breach Log & Incident Management
- Incident recording with severity classification
- Root cause analysis templates
- Remediation tracking
- Regulatory incident reporting

#### Module 11: Escalation Matrix
- Configurable rules engine for automatic escalation
- Multi-level notification routing
- SLA management per escalation level

#### Module 12: TAT (Turnaround Time) Dashboard
- Process monitoring across all modules
- SLA tracking with breach alerts
- Bottleneck identification
- Performance metrics per team/individual

#### Module 13: Executive Dashboard
- KPI tracking with trend indicators
- Risk heat maps (entity-level, portfolio-level)
- Compliance health score
- Trend analysis with ML predictions
- PDF and Excel export

#### Module 14: Reporting & Analytics
- Scheduled report generation
- Custom report builder with drag-and-drop
- Compliance, risk, fraud, and operational report types
- Regulatory filing templates

#### Module 15: Help System & User Guidance
- Video tutorials library
- Knowledge base with search
- Interactive walkthroughs for new users
- Help content analytics

---

## 6. Common Corridor Strategy

The "Common Corridor" is the set of countries whose regulatory frameworks are most interconnected — mastering them creates a network effect.

### 6.1 Country Coverage Matrix

| Feature | UAE | KSA | UK | Canada | Australia |
|---|---|---|---|---|---|
| **Immigration** | Golden Visa, Employment | Premium Residency, Work Visa | Skilled Worker, Student, Family | Express Entry, PNP, Study | PR, Student, 485, Tourist |
| **Banking GRC** | CBUAE, AML/CFT | SAMA, AML/CFT | FCA/PRA, AML | FINTRAC, OSFI | ASIC, APRA, AUSTRAC |
| **Key Regulator** | MOHRE, DED, ICP | Qiwa, MISA | Home Office, HMRC | IRCC, CRA | HomeAffairs, ATO |
| **Data Residency** | UAE (me-central-1) | KSA (me-central-1) | UK (eu-west-2) | Canada (ca-central-1) | Australia (ap-southeast-2) |
| **Language** | Arabic + English | Arabic + English | English | English + French | English |
| **Config Pack Status** | Planned | Planned | Planned | Planned | Planned |

### 6.2 Country-Specific Requirements by Vertical

**Immigration — Australia**:
- VEVO (Visa Entitlement Verification Online) integration
- Department of Home Affairs ImmiAccount integration
- APF (Application Processing Fee) calculation and tracking
- Health insurance mandatory validation (OSHC for students, OVHC for workers)
- Skills assessment authority integration (ACS, Engineers Australia, VETASSESS, etc.)
- Sponsor monitoring obligations for 482/494 visas

**Immigration — Canada**:
- IRCC (Immigration, Refugees and Citizenship Canada) portal integration
- Express Entry CRS score calculator
- Provincial Nominee Program (PNP) tracking per province
- LMIA (Labour Market Impact Assessment) workflow
- Biometrics appointment scheduling
- CAQ (Quebec) special workflow

**Banking — UAE**:
- CBUAE (Central Bank of UAE) regulatory reporting
- goAML (Financial Intelligence Unit) SAR filing
- UAE Local Terrorist List auto-sync
- DED (Department of Economic Development) business registry
- ICP (Identity & Citizenship) identity verification

**Banking — KSA**:
- SAMA (Saudi Central Bank) compliance rules
- Qiwa labor platform integration
- ZATCA e-invoicing compliance
- MISA (Ministry of Investment) foreign investor verification

---

## 7. User Journeys

### Journey 1: Immigration Firm Onboarding (Day 1)

```
1. Firm admin signs up at immistack.com → enters email, password
2. 7-step onboarding wizard:
   a. Enters firm name "Global Migration Partners", selects AU+UK as countries
   b. Configures 5 staff for AU (Student, PR visas), 3 staff for UK (Skilled Worker)
   c. Uploads CSV of 200 existing clients → maps columns to Meru fields
   d. Selects "Online payments via Stripe" + EMI enabled
   e. Chooses "Platform-managed encrypted storage"
   f. Uploads logo, picks brand colors, selects "Professional" invoice template
   g. Enables Australia Module ($299/mo) + UK Module ($249/mo) + AI Engine ($199/mo)
3. Clicks "Launch Workspace" → POST /api/v1/tenants/onboard
4. Lands on Admin AI Home: "Good morning, Sarah. What would you like to do today?"
5. Invites 7 staff members via email → they receive invite links
6. Staff log in, see their Kanban board pre-populated with migrated cases
```

### Journey 2: Visa Application Processing (Daily Workflow)

```
1. Staff opens Staff Portal, sees Kanban board
2. Drags "John Smith — Student Visa 500" card from "Documents Pending" to "Application Draft"
3. System auto-fires PATCH /api/v1/cases/{id}/stage, updates audit log
4. Staff opens case detail, reviews document checklist:
   - Passport ✅ | CoE ✅ | Financials ✅ | English Test ❌ | Health Insurance ⚠️ (expiring)
5. Staff clicks "Request Document" → Client receives push notification + email
6. Client opens Client Portal → uploads English test result via drag-and-drop
7. Staff receives notification: "John Smith uploaded a document"
8. Staff reviews document, marks as "Verified" ✅
9. Staff prepares application draft using AI assistance: "Draft a 500 visa application for John"
10. Staff sends draft to client for review → Client approves via Client Portal
11. Staff submits application → Stage moves to "Submitted"
12. VEVO auto-check runs weekly, updates case status
```

### Journey 3: Sanctions Screening (Banking)

```
1. Bank relationship manager creates new corporate customer entity
2. System auto-triggers sanctions screening on company name + all directors + UBOs
3. Screening engine runs fuzzy match against OFAC, EU, UN, UK HMT, UAE lists
4. Alert: 70% match on a director name against UAE Local Terrorist List
5. System auto-creates RFI case, assigns to compliance officer
6. Compliance officer reviews match in GovernanceX dashboard
7. Requests additional documentation: passport copy, proof of address, source of funds
8. Customer uploads documents via secure portal
9. Document Intelligence Layer runs fraud detection → passes
10. Compliance officer marks as "False Positive — name similarity only"
11. System logs decision with full audit trail (hash-chained, WORM)
12. Customer onboarding continues
```

---

## 8. Non-Functional Requirements

### 8.1 Performance

| Metric | Target |
|---|---|
| API response time (p50) | < 100ms |
| API response time (p95) | < 500ms |
| Sanctions screening (single name, p95) | < 200ms |
| Sanctions screening (batch, 10k names) | < 60 seconds |
| Document upload (10MB file) | < 5 seconds |
| AI chat response (first token) | < 2 seconds |
| Search results (full-text) | < 300ms |
| Page load (LCP, frontend) | < 2.5 seconds |

### 8.2 Security

| Requirement | Standard |
|---|---|
| Authentication | OAuth 2.0 / OIDC, JWT (RS256), MFA (TOTP + SMS fallback) |
| Authorization | RBAC + ABAC, tenant-level isolation |
| Encryption at rest | AES-256-GCM, per-vertical KMS keys |
| Encryption in transit | TLS 1.3 (enforced) |
| Multi-tenancy isolation | RLS at DB layer, network policies at infra layer |
| Audit integrity | Hash-chained, WORM, exportable |
| Penetration testing | Quarterly, by external firm |
| Vulnerability scanning | Every CI build (Trivy), weekly dependency audit |

### 8.3 Availability & Resilience

| Requirement | Target |
|---|---|
| Uptime SLA | 99.9% (8.76 hours downtime/year) |
| RPO (Recovery Point Objective) | < 1 hour (continuous WAL archiving) |
| RTO (Recovery Time Objective) | < 4 hours |
| Multi-region failover | UAE → KSA (active-passive) |
| Data residency | In-country for regulated verticals (UAE, KSA, UK, AU) |

### 8.4 Accessibility

- WCAG 2.1 AA compliance (minimum)
- Keyboard navigation on all forms and interactive elements
- Screen reader support (ARIA labels, roles, live regions)
- Color contrast ratio ≥ 4.5:1 (normal text), ≥ 3:1 (large text)
- Focus visible outlines on all interactive elements

### 8.5 Scalability

| Dimension | Target |
|---|---|
| Tenants per vertical | 10,000+ |
| Users per tenant | 500+ |
| Documents per tenant | 100,000+ |
| Cases per tenant | 50,000+ |
| Concurrent API requests | 1,000/second per instance |
| Database size | 10TB+ per vertical |

---

## 9. Release Phases

### Phase 0 — Current State (Complete)
- Meru Core: NestJS monolith with all 14 modules scaffolded
- ImmiStack: Next.js 15 frontend with 4 portals, mock API mode
- GovernanceX: Standalone prototype (95% complete, needs integration)
- Deployment: Docker Compose on EC2, 3 verticals × 3 environments
- **Status**: Foundation exists. Not production-ready.

### Phase 1 — Meru Core Stabilization (Weeks 1-6)
- [ ] Connect ImmiStack to real Meru Core API (remove mock layer)
- [ ] Implement JSON config pack system (`packages/config-packs/`)
- [ ] Build God View at `app.meru.com` (tenant management, feature flags)
- [ ] Add module-level tests (target: 70% coverage on core modules)
- [ ] Production harden: remove `synchronize: true`, add connection pooling, add rate limiting per tenant
- [ ] Implement Screening Engine (highest-value specialist engine)
- [ ] Security audit + penetration test

### Phase 2 — ImmiStack Launch (Weeks 7-12)
- [ ] Complete end-to-end integration with Meru Core
- [ ] Australia config pack (VEVO, visa types, HomeAffairs integration)
- [ ] Stripe payment integration (live)
- [ ] Document OCR pipeline
- [ ] Production deployment (api.immistack.com, app.immistack.com)
- [ ] Beta launch with 3-5 immigration firms
- [ ] User testing, feedback collection, iteration

### Phase 3 — GovernanceX Integration (Weeks 13-20)
- [ ] Extract GovernanceX backend logic into Meru Core modules
- [ ] Build GovernanceX Next.js frontend (replacing standalone React app)
- [ ] UAE banking config pack (CBUAE, AML/CFT, goAML)
- [ ] Integrate Screening Engine with live sanctions lists
- [ ] Finacle core banking adapter
- [ ] World-Check One + Dow Jones integration
- [ ] Beta launch with 1-2 banks in UAE

### Phase 4 — Specialist Engines (Weeks 21-30)
- [ ] Regulatory Radar (crawler + diff detection + auto-PR)
- [ ] Document Intelligence Layer (fraud detection, advanced OCR)
- [ ] Vessel/Asset Tracking Engine (AIS integration, geofencing)
- [ ] Add Canada + UK country packs for ImmiStack
- [ ] Add KSA country pack for GovernanceX

### Phase 5 — Platform Scale (Weeks 31-52)
- [ ] Extract modules into independent deployables (monorepo)
- [ ] Multi-region Kubernetes deployment (UAE, KSA, UK, AU)
- [ ] Launch 3rd vertical: Tax/VAT (ZATCA e-invoicing, MTD VAT)
- [ ] Launch 4th vertical: Labour (MOHRE work permits, Emiratisation/Saudization)
- [ ] Partner SDK for external vertical developers
- [ ] SOC 2 Type II certification

---

## 10. Success Metrics

### 10.1 North-Star Metrics (from CLAUDE.md)

| Metric | Target |
|---|---|
| Time to launch a new vertical | ≤ 6 weeks |
| Time to onboard a new country | ≤ 3 weeks |
| % of feature code shared across verticals | ≥ 80% |
| AI response citation coverage | 100% |
| Regulatory Radar lag (rule change → draft pack) | ≤ 24 hours |
| Tenant data-isolation incidents | **0 (ever)** |

### 10.2 Vertical-Specific KPIs

**ImmiStack**:
- Firms onboarded (Month 1: 3-5 beta → Month 6: 50+)
- Active cases on platform
- Document upload completion rate (clients completing document checklists)
- AI assistant usage (% of staff using AI chat daily)

**GovernanceX**:
- Transactions screened per month
- Sanctions screening false positive rate (< 5%)
- RFI response time (client → document submission)
- SAR (Suspicious Activity Report) filings through platform

### 10.3 Platform Health Metrics

- API uptime (99.9% target)
- P95 latency per endpoint
- Database query performance (slow query log < 100ms)
- Audit log chain integrity (100% verified monthly)
- Backup/restore test success (quarterly)

---

*This document defines the product requirements for the Meru RegOS platform. Feature prioritization is governed by the release phases in Section 9. All features must satisfy the non-functional requirements in Section 8.*
