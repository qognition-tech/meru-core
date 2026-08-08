# Feature Parity Map — GovernanceX 143 + Immigration BRD → Meru RegOS

> Compiled 2026-08-09 by mapping every named feature in
> `GovernanceX_Features_Report.docx` and the Qognition immigration BRD onto the
> 14 core modules, 4 engines and the config-pack schema — then verifying each
> claim against the **live** deployment (`https://meru-core.vercel.app`), not
> against documentation.
>
> Supersedes the gap tables in `docs/MASTER_GAP_ANALYSIS_AND_PLAN.md` §1 where
> the two disagree; that document's phase plan (§2) still stands.

---

## 0. First: what the handoff document got right, and three things it did not

`meru-core-fe/BACKEND-HANDOFF.md` was re-verified end to end over HTTP.

**Confirmed accurate:** 226 paths / 273 operations at `/api-json`; `/health`
200 with `database: "up"`; runtime role `meru_app` with `bypassrls: false`;
`watchlist-status` reporting **20,210** entries; `GET /jobs/status` → **403**
for `firm_admin` and 200 for `platform_admin`; unauthenticated `/crm/entities`
→ **401**; `/billing/checkout` → clean **503**; `GET /payments/summary`
grouping by currency; `GET /documents/checklist` rendering from
`au-immigration@1.0.0`; both demo logins working.

Three corrections, all of which change what the frontend should do:

### 0.1 The demo tenants are on `status: "trial"`, not `"active"`

`GET /tenants/me/entitlements` returns:

```jsonc
{ "vertical": "immigration", "plan": "enterprise", "status": "trial",
  "trialEndsAt": "2026-08-22T14:51:21.131Z", "modules": [ … ], "connectors": [] }
```

The handoff's example shows `"status": "active", "trialEndsAt": null`. Any UI
branching on `status === 'active'` renders the wrong state for **both** demo
tenants today, and the trial lapses **2026-08-22** — after which the demo
accounts change behaviour and it will look like a regression.

### 0.2 `POST /ai/execute` returns **HTTP 500** for every tenant

```
POST /ai/execute {"category":"entity_analysis","input":"hello"}
→ 500 MER-SRV-0001 "Prompt not found: entity_analysis"
```

`GET /ai/prompts` returns `[]`. The prompt library is **empty and unseeded**,
so the GovAI command bar — recorded as shipped and wired to the real route —
fails for every tenant, and fails as a 500 (an internal fault) rather than a
503 (a configuration gap). `GET /notifications/templates` is **also empty**,
which makes every "email template" feature in both specs non-functional even
once `RESEND_API_KEY` lands.

This is the exact failure class AGENTS.md §4 already names: *a feature whose
data source is empty has not been tested, only executed.* It was true of
`watchlist_entries` and it is true of `ai_prompts` and `notification_templates`
right now.

### 0.3 One stale `notImplemented()` seam

`governancex/lib/api/services/rfi.service.ts:59` still routes RFI updates
through `notImplemented('PUT /forms/:id')`. That route **shipped** and is live.
RFI editing is dead in the UI for no reason. (It is the only remaining
`notImplemented()` call site in all three apps, and nothing imports
`immistack/lib/mocks/dummy-data.ts` — mock leakage is genuinely gone.)

### 0.4 Also worth correcting in the older docs

`MASTER_GAP_ANALYSIS_AND_PLAN.md` B1 says "no Stripe — `stripe` absent from
package.json". `stripe` **is** a dependency and the webhook shipped; the only
thing missing is the key. B10 (only 2 config packs) is still exactly true.

### 0.5 A note on the repo you should not work in

`~/Documents/GitHub/immistack` is a **separate 35-page prototype** on
`qognition-tech/immistack-app` (3 commits, last touched at "genesis" + a CVE
bump). It still contains the duplicate `/platform/*` console that was
deliberately deleted from `meru-core-fe/immistack`. It is not a mirror and it
is not in sync. The live app is `meru-core-fe/immistack` (31 pages). Do not
develop in the standalone clone.

---

## 1. What "143 features" actually is

The report's own headline says "143+ feature modules". The document body
contains **21 modules / 174 feature rows / 165 unique feature names** — nine
names appear in two modules each (`Version Control`, `Document Annotations`,
`Document Relationships`, `Advanced Search`, `Trend Analysis`,
`RFI SLA Management`, `Risk Workshop`, `Turnover Audit Log`,
`Email Notifications`). All 174 rows are mapped below; the duplicates are
marked so nobody schedules the same work twice.

The immigration BRD resolves to a further **117 distinct requirements**.
**291 rows total.**

---

## 2. Headline result

| | GovX (174 rows) | BRD (117 rows) |
|---|---|---|
| **Live in core today** | 64 (37%) | 44 (38%) |
| **Config-pack authoring only — zero code** | 17 (10%) | 12 (10%) |
| **Pack-schema extension + one generic evaluator** | 15 (9%) | 17 (15%) |
| **Core code (small)** | 39 (22%) | 15 (13%) |
| **Core code (medium)** | 13 (7%) | 12 (10%) |
| **Core code (large)** | 2 (1%) | 1 (1%) |
| **Blocked on a credential only** | 10 (6%) | 9 (8%) |
| **Blocked on a commercial/government contract** | 7 (4%) | 1 (1%) + 3 hybrid |
| **Impossible on the current deployment** | 5 (3%) | 1 (1%) |
| **Should not live in horizontal core** | 2 (1%) | 5 (4%) |

**~47% of both specs is already satisfied or needs nothing but JSON.** That is
the 80/20 model working. The problem is the other half, and it is not the
problem the roadmap assumes.

### 2.1 The actual diagnosis: the pack schema is the bottleneck, not the modules

Only **3 rows out of 291** are large engineering (`Predictive Risk Modeling`,
`ML Pattern Detection`, the three CRM importers). Everything else is small.
But **32 rows are blocked on the same thing**: the config-pack schema has no
vocabulary for them, so today each one can only be built as vertical-specific
code inside `src/` — which `CLAUDE.md` §11.3 forbids, and which is precisely
how an 80/20 platform becomes two bespoke products.

`packages/config-packs/_schema/pack.schema.ts` can express: regulators, roles,
documentTypes, workflows, screening, compliance, kpis, entityTypes, uiConfig.
It **cannot** express any of the following, each of which recurs in *both*
verticals:

| Missing pack vocabulary | ≈ rows | What it replaces |
|---|---|---|
| `alertRules[]` — condition, severity, escalation ladder | 11 | visa expiry alerts, turnover alerts, breach detection, payment-overdue, SLA alerts, document expiry |
| `messaging{ templates[], sequences[] }` | 8 | email templates, automation, RFI follow-up, payment reminders, newsletters |
| `feeSchedules[]` + `paymentPlans[]` | 5 | government fees, EMI, stage-gated payments, disbursements |
| `rules[]` — declarative expressions (json-logic) | 5 | OSHC/APF eligibility, cross-field validation, workflow triggers, case-freeze |
| `prompts[]` — the AI prompt library | 4 | **fixes the `/ai/execute` 500**, GovAI, draft generation, chatbot |
| `scoringModels[]` | 3 | lead scoring, visa recommendation, generic risk scoring |
| `relationships[]` | 3 | document relationships, task/milestone dependencies |
| `dashboards[]` + `navigation[]` | 2 | sidebar per vertical, widget layout, i18n keys |
| `importMappings[]` | 1 | CRM field maps for CSV/HubSpot/Zoho/Salesforce |

(Several rows need two of these, so the column sums above 32.)

Nine additions to one Zod file, plus **nine small generic evaluators** in core
that read them. That is the whole design. Every one of those evaluators is
horizontal by construction — an alert-rule engine does not know what a visa is.

### 2.2 The three things that are not engineering problems at all

1. **Five GovX rows (Real-Time Collaboration, Team Chat, Workspace
   Collaboration, User Presence, Collaborative Documents) cannot be built on
   Vercel.** Functions terminate per invocation. This needs a host decision
   (always-on service, or Ably/Pusher), not a sprint.
2. **Seven rows need a signed contract** (Refinitiv WorldCheck, Dow Jones,
   Finacle ×2, adverse media/PEP, sender reputation, HS-code price
   benchmarks) and four more need a government licence (VEVO, IRCC, UK Home
   Office, INZ). The adapters exist in sandbox. Code cannot obtain the data.
3. **Nineteen rows are blocked on a credential that costs nothing but a
   decision** — see §5. This is the cheapest work available anywhere on this
   list and it is currently the largest single blocker.

---

## 3. GovernanceX — all 174 rows

**Verdict key:** `LIVE` works in core today · `PACK` config-pack authoring
only, no code · `SCHEMA` needs a pack-schema extension + one generic evaluator
· `CORE-S/M/L` needs core code, small/medium/large · `KEY` blocked on a
credential only · `EXT` blocked on a commercial or government contract ·
`HOST` impossible on the current deployment · `NO` should not live in
horizontal core.

### Module 1 — Sanctions Screening & Counterparty Due Diligence

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Real-Time Screening Engine | **LIVE** | Engine: Screening | POST /engines/screening; p95 104ms |
| 2 | Fuzzy Logic Matching | **LIVE** | Engine: Screening | Jaro-Winkler + Levenshtein + Soundex + Double Metaphone, corroboration-gated (60a8326) |
| 3 | Adverse Media & PEP Check | **EXT** | Engine: Screening | pack flags screening.pepCheck/adverseMedia exist; no data source is free |
| 4 | Match Review Workflow | **PACK** | CRM + WF | entityType screening_match in ae-banking; True-Match/FP disposition states |
| 5 | Scheduled Rescreening | **LIVE** | Engine: Screening | rescreening.service.ts + screening_results; refuses to run on empty list |
| 6 | Bulk Import & Screening | **CORE-S** | Engine: Screening + QUEUE | no CSV/XLSX batch endpoint; queue module already handles fan-out |
| 7 | WorldCheck Integration | **EXT** | INT | Refinitiv contract; connector-registry credential slot exists |
| 8 | Dow Jones Integration | **EXT** | INT | Dow Jones R&C contract; same slot |
| 9 | Sanctions List Sync | **LIVE** | Engine: Screening | watchlist-ingest.service.ts; 20,210 entries live. OFAC SDN + UN only - EU CFSP + UK OFSI still to add (free) |
| 10 | Email Notifications | **KEY** | COM | Resend transport shipped; RESEND_API_KEY unset so invites/alerts only log |

### Module 2 — Document Verification & Fraud Detection

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | AI Document Verification | **KEY** | Engine: DocIntel | POST /engines/doc-intel + /documents/:id/analyze; needs OPENAI_API_KEY |
| 2 | Fraud Pattern Recognition | **LIVE** | Engine: DocIntel | EXIF, font consistency, duplicate hash; per-documentType fraudChecks in pack |
| 3 | Batch Document Processing | **CORE-S** | DOC + QUEUE | no batch upload/verify endpoint |
| 4 | Document Annotations | **CORE-S** | DOC + CRM | CRM note is polymorphic; needs region anchors + a generic comments surface |
| 5 | Document Relationships | **SCHEMA** | DOC | needs pack `relationships[]` + a generic edge table; today only metadata.documentTypeKey |
| 6 | Version Control | **LIVE** | DOC + storage | /documents/:id/versions and /storage/files/:id/versions |
| 7 | OCR & Data Extraction | **KEY** | Engine: DocIntel | engine does Vision OCR; DOC module's own text extraction is still a placeholder |
| 8 | Fraud Pattern Matching | **CORE-M** | Engine: DocIntel | cross-tenant duplicate hashing exists; no historical fraud_patterns store to match against |

### Module 3 — Trade Finance & Vessel Tracking

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | TBML Risk Scoring | **LIVE** | INT + Engine: Vessel | /integrations/trade |
| 2 | Price Benchmark Analysis | **CORE-M** | INT | no benchmark reference data; needs HS-code price source |
| 3 | Vessel Tracking | **LIVE** | Engine: Vessel | real NMEA/AIS decoding, vessel_positions |
| 4 | Geofencing Alerts | **LIVE** | Engine: Vessel | /integrations/vessel/alerts + watchlist, geolib |
| 5 | Vessel Analytics | **LIVE** | Engine: Vessel | dark-period detection; riskScore null means unknown, never green |
| 6 | Trade Finance Verification | **LIVE** | INT | /integrations/trade CRUD + trade_instrument entity |
| 7 | ML Pattern Detection | **CORE-L** | AI | heuristics only today; a trained model needs labelled data nobody has yet |
| 8 | SAR Management | **LIVE** | INT + CRM | /integrations/{cc}/str filing (sandbox) + GovX SAR page |
| 9 | TBML Case Management | **LIVE** | CRM + WF | case + trade_instrument entity types |

### Module 4 — AI-Powered Regulatory Intelligence

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Regulatory Change Detection | **LIVE** | Engine: Radar | POST /engines/radar/scan, scheduled diffing |
| 2 | Impact Assessment | **CORE-M** | Engine: Radar + AI | diff exists; no impact scoring against the tenant's obligations |
| 3 | Gap Analysis | **CORE-M** | Engine: Radar + CRM | needs obligation<->rule linkage |
| 4 | Policy Recommendations | **CORE-M** | Engine: Radar + TCM | the spec promise: radar drafts a config-pack diff + PR. Not built (B14) |
| 5 | Regulatory Calendar | **SCHEMA** | TCM + TASK | pack compliance.reportingObligations exists but nothing renders a calendar from it |
| 6 | CBUAE Rulebook Integration | **LIVE** | Engine: Radar | source registered; site blocks bots, crawled server-side |
| 7 | Regulatory Data API | **LIVE** | INT | /integrations/{ae,sa,qa,bh}/regulatory-updates - all SANDBOX |
| 8 | Natural Language GRC | **CORE-S** | AI | /ai/execute is live but ai_prompts is EMPTY -> HTTP 500 'Prompt not found'. Prompts must become pack-driven |

### Module 5 — AI Agent Orchestration & Automation

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | AI Agent Management | **LIVE** | Orchestration | GET /orchestration/agents |
| 2 | Agent Task Orchestration | **LIVE** | Orchestration + QUEUE | POST /orchestration/agents/:id/run |
| 3 | Automated Control Testing | **PACK** | Orchestration + CRM | control_test entityType in pack; agent type needs registering |
| 4 | Vendor Due Diligence | **PACK** | CRM + Engine: Screening | vendor entityType; GovX page built |
| 5 | Risk Assessment Automation | **PACK** | CRM + AI | risk_scenario entityType |
| 6 | Agent Performance Tracking | **LIVE** | Orchestration | /agents/:id/logs + /orchestration/health |
| 7 | Approval Workflows | **LIVE** | WF | workflow instances + transitions |
| 8 | Orchestration Logs | **LIVE** | Orchestration + AUD | agent_runs table |

### Module 6 — Task & Process Management

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Task Management | **LIVE** | TASK | full CRUD, start/complete/cancel/comments, my-work |
| 2 | Process Step Tracking | **LIVE** | WF | workflow instances + transitions |
| 3 | Stakeholder Management | **CORE-S** | CRM + TASK | assignees only; no stakeholder role per case |
| 4 | Deadline Notifications | **LIVE** | TASK + COM | depends on RESEND_API_KEY and an external scheduler |
| 5 | Task Recurrence | **LIVE** | TASK | /tasks/recurring-jobs with pause/resume, cron-parser |
| 6 | Workflow Orchestration | **LIVE** | WF | BPMN-ish state machine |
| 7 | Workflow Templates | **PACK** | WF + TCM | pack workflows[] with steps, SLAs, transitions |
| 8 | Workflow Triggers | **SCHEMA** | WF | event->workflow start needs pack `rules[]`; today only manual start |
| 9 | Workflow Chains | **SCHEMA** | WF | step type api_call exists; chaining one workflow into another does not |
| 10 | Task Proposals | **CORE-S** | AI + TASK | AI-suggested tasks with human accept/reject |

### Module 7 — Compliance Obligations & Breach Management

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Compliance Obligations Registry | **PACK** | CRM | obligation entityType is in the code enum but NOT in ae-banking.json -> no vocabulary |
| 2 | Compliance Monitoring | **SCHEMA** | WF + BI | needs pack `rules[]` to express 'obligation breached when...' |
| 3 | Breach Management | **PACK** | CRM + WF | breach entityType in enum, missing from the pack |
| 4 | Breach Reporting | **LIVE** | INT | /integrations/{cc}/str + compliance.reportingObligations |
| 5 | Remediation Tracking | **LIVE** | TASK | tasks linked to the breach entity |
| 6 | Compliance Reporting | **LIVE** | BI + AUD | /analytics/reports + /audit/compliance/:standard |
| 7 | Escalation Management | **CORE-S** | WF | sla-watchdog detects breaches; the response is still a TODO (line 156/170) |
| 8 | Compliance Calendar | **SCHEMA** | TCM + TASK | same calendar surface as the Regulatory Calendar |

### Module 8 — KPI & Performance Monitoring

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | KPI Definitions | **PACK** | TCM + BI | pack kpis[] with unit, target, alert threshold |
| 2 | KPI Tracking | **LIVE** | BI | /analytics/widgets/:id/execute |
| 3 | HR KPI Management | **PACK** | BI | a KPI set, not a feature - author it in the pack |
| 4 | Performance Analytics | **LIVE** | BI | /analytics/reports |
| 5 | Dashboard Widgets | **LIVE** | BI | widget CRUD + execute |
| 6 | Performance Metrics | **LIVE** | BI |  |
| 7 | Analytics Metrics | **LIVE** | BI |  |
| 8 | Trend Analysis | **CORE-S** | BI | point-in-time only; no time-series rollup |

### Module 9 — Document Management & Library

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Document Library | **LIVE** | DOC | /documents + /documents/entity/:type/:id |
| 2 | Version Control | **LIVE** | DOC | (duplicate of 2.6) |
| 3 | Document Lifecycle | **LIVE** | DOC | lifecycle columns migration + document-hub.service |
| 4 | Collaborative Documents | **HOST** | DOC | concurrent editing needs a persistent connection Vercel cannot hold |
| 5 | Document Annotations | **CORE-S** | DOC | (duplicate of 2.4) |
| 6 | Digital Certificates | **KEY** | DOC | e-signature needs a DocuSign/Dropbox Sign key |
| 7 | Document Relationships | **SCHEMA** | DOC | (duplicate of 2.5) |
| 8 | Advanced Search | **CORE-M** | SRCH | the finished Elasticsearch service is imported by nobody; the facade is Postgres ILIKE (B11) |
| 9 | Storage Integration | **LIVE** | Storage | S3 only - multipart, versions, storage classes, restore |

### Module 10 — Turnaround Time (TAT) & SLA Management

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | TAT Recording | **CORE-S** | WF | instance timestamps exist; no TAT record or per-stage clock |
| 2 | SLA Configuration | **PACK** | TCM + WF | pack workflow step slaHours |
| 3 | SLA Monitoring | **LIVE** | WF | sla-watchdog.service.ts detects breaches |
| 4 | TAT Analytics | **CORE-S** | BI | depends on TAT recording |
| 5 | SLA Alerts | **CORE-S** | WF + COM | watchdog action is a TODO |
| 6 | RFI SLA Management | **CORE-S** | WF + FORM | same watchdog gap, applied to RFI |

### Module 11 — Knowledge Base & Training

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Knowledge Base Articles | **PACK** | CRM + DOC | knowledge_article entityType; GovX page built |
| 2 | Article Recommendations | **CORE-S** | SRCH + AI | pgvector + /ai/embeddings exist; needs a similarity endpoint |
| 3 | Training Modules | **PACK** | CRM | training_module entityType; GovX page built |
| 4 | User Training Progress | **CORE-S** | CRM + IAM | no per-user progress record |
| 5 | Video Tutorials | **LIVE** | Storage | upload + signed download already work |
| 6 | Help Videos | **LIVE** | Storage | same surface |
| 7 | Help Analytics | **CORE-S** | BI | needs view/complete events |
| 8 | AI Chatbot | **CORE-S** | AI | /ai/execute; blocked by the empty prompt library above |

### Module 12 — Collaboration & Communication

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Real-Time Collaboration | **HOST** | - | needs an always-on host or Ably/Pusher |
| 2 | Team Chat | **HOST** | COM | same |
| 3 | Workspace Collaboration | **HOST** | - | same |
| 4 | User Presence | **HOST** | IAM | same |
| 5 | Comments System | **CORE-S** | CRM | tasks have comments; nothing else does. CRM note is polymorphic - promote it |
| 6 | Activity Feed | **LIVE** | Orchestration + AUD | /orchestration/events + audit log by entity |
| 7 | Kanban Boards | **LIVE** | FE + WF | GovX and ImmiStack both live |
| 8 | Risk Workshop | **PACK** | CRM | risk_scenario entityType; GovX page built |

### Module 13 — Request for Information (RFI) Management

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | RFI Tracking | **PACK** | CRM + FORM | rfi entityType in ae-banking |
| 2 | RFI Workflow | **LIVE** | WF + FORM | form submissions + review |
| 3 | RFI Analytics | **CORE-S** | BI |  |
| 4 | RFI Unified Search | **CORE-M** | SRCH | depends on the Elasticsearch wiring |
| 5 | RFI Email Templates | **KEY** | COM | /notifications/templates works but the table is EMPTY - nothing is seeded |
| 6 | RFI Scheduler | **CORE-S** | COM + QUEUE | /queue/scheduled exists; no send-later on notifications |
| 7 | RFI SLA Management | **CORE-S** | WF | (duplicate of 10.6) |
| 8 | RFI Email Delivery | **KEY** | COM | Resend shipped; needs the key |
| 9 | RFI A/B Testing | **CORE-M** | COM | no variant/assignment model |
| 10 | Automated Follow-up | **SCHEMA** | COM | needs pack `sequences[]` - a declarative multi-step send |

### Module 14 — Email Automation & Analytics

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Email Templates | **KEY** | COM | surface live, table empty, no seeder |
| 2 | Email Automation | **SCHEMA** | COM | pack `sequences[]` |
| 3 | Email Analytics | **CORE-M** | COM + BI | needs delivery/open/click events |
| 4 | Email Delivery Tracking | **CORE-S** | COM | needs a Resend inbound webhook -> notification status |
| 5 | Sender Reputation | **EXT** | COM | provider-side metric; needs Resend/ESP analytics access |
| 6 | A/B Testing | **CORE-M** | COM | (same model as 13.9) |
| 7 | Winner Detection | **CORE-S** | COM + BI | depends on A/B + analytics |
| 8 | Response Sentiment | **CORE-S** | AI + COM | feasible once inbound mail is parsed |
| 9 | Performance Benchmarking | **CORE-S** | BI |  |
| 10 | Email Provider Config | **CORE-S** | COM | Resend is hardcoded; needs a per-tenant provider record |
| 11 | Recipient Management | **CORE-S** | COM + CRM | no list/segment model |
| 12 | Email Notifications | **KEY** | COM | (duplicate of 1.10) |

### Module 15 — Integration & System Connectivity

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Finacle Integration | **EXT** | INT | needs the bank's own Finacle environment + contract |
| 2 | Finacle Sync Scheduler | **EXT** | INT + QUEUE | same |
| 3 | External System Integrations | **LIVE** | INT | connector registry: GET/PUT /integrations/connectors, AES-256-GCM credentials |
| 4 | Webhook Integration | **CORE-S** | INT | inbound Stripe webhook only; NotificationType.WEBHOOK exists but there is no outbound dispatcher |
| 5 | SSO Integration | **LIVE** | IAM | SAML initiate/callback live |
| 6 | Two-Factor Authentication | **LIVE** | IAM | TOTP via otplib; setup/verify/disable |
| 7 | Biometric Authentication | **CORE-M** | IAM | WebAuthn/passkeys - server-side challenge store needed |
| 8 | API Management | **LIVE** | IAM | API keys, rate limiting via express-rate-limit |
| 9 | Integration Testing | **LIVE** | INT | /integrations/adapters/health |

### Module 16 — Turnover & Financial Monitoring

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Turnover Monitoring | **PACK** | CRM | turnover_record entityType; GovX page built |
| 2 | Turnover Sync Jobs | **EXT** | INT | the data comes from Finacle |
| 3 | Turnover Forecasting | **CORE-M** | BI + AI |  |
| 4 | Turnover Alerts | **SCHEMA** | WF + COM | pack `alertRules[]` |
| 5 | Turnover Notification Preferences | **LIVE** | COM | GET/PUT /notifications/preferences |
| 6 | Turnover Audit Log | **LIVE** | AUD | hash-chained, WORM triggers |

### Module 17 — Audit Trail & Logging

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Audit Logging | **LIVE** | AUD | hash-chained; /audit/logs/verify-chain |
| 2 | Audit Trail Viewer | **LIVE** | AUD | by entity, by user, export |
| 3 | Audit Retention | **CORE-S** | AUD | pack compliance.retentionYears is declared but nothing enforces it |
| 4 | Audit Notifications | **CORE-S** | AUD + COM | no alert on a chain-verification failure |
| 5 | Turnover Audit Log | **LIVE** | AUD | (duplicate of 16.6) |
| 6 | Agent Orchestration Logs | **LIVE** | Orchestration | (duplicate of 5.8) |

### Module 18 — Alerts & Monitoring

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Alert Rules Engine | **SCHEMA** | WF (new rules sub-module) | THE central gap. There is no generic rules engine anywhere; pack kpis[].alert is the only threshold concept |
| 2 | Real-Time Alerts | **CORE-S** | COM | polling is fine; push needs the HOST decision |
| 3 | Alert Management | **SCHEMA** | WF + COM | ack/snooze/assign on top of alertRules |
| 4 | Alert Escalation | **SCHEMA** | WF | escalation ladder as pack config |
| 5 | Monitoring Dashboard | **LIVE** | BI + jobs | /jobs/status (job_runs persisted) + /platform/stats |
| 6 | Scheduled Reports | **CORE-S** | BI + QUEUE | /analytics/reports/:id/execute + /queue/scheduled exist; no glue |
| 7 | Report Scheduler | **CORE-S** | BI + QUEUE | same |
| 8 | Notification Digest | **CORE-S** | COM | no batching/rollup |
| 9 | Notification Preferences | **LIVE** | COM | (duplicate of 16.5) |

### Module 19 — Risk Intelligence & Predictive Analytics

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Risk Intelligence | **LIVE** | Orchestration + AI | /orchestration/entity/:id/insights |
| 2 | Predictive Risk Modeling | **CORE-L** | AI + BI | needs labelled history |
| 3 | Risk Scoring | **SCHEMA** | AI | vessel/TBML/screening each score in their own way; no generic pack `scoringModels[]` |
| 4 | Risk Integration | **LIVE** | Orchestration | insights aggregate across modules |
| 5 | Risk Indicators | **SCHEMA** | BI | indicator definitions belong in the pack |
| 6 | Trend Analysis | **CORE-S** | BI | (duplicate of 8.8) |
| 7 | Risk Workshop | **PACK** | CRM | (duplicate of 12.8) |

### Module 20 — Governance Milestones & Roadmap

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Governance Milestones | **PACK** | CRM | milestone entityType; GovX page built |
| 2 | Roadmap Visualization | **LIVE** | FE | GovX roadmap page |
| 3 | Milestone Tracking | **LIVE** | CRM + TASK |  |
| 4 | Dependency Management | **CORE-S** | TASK | no task/milestone dependency edges |

### Module 21 — Advanced Features

| # | Feature | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Mobile App Support | **NO** | FE | PWA polish belongs in the vertical app; native is out of core scope |
| 2 | Multi-Language Support | **CORE-S** | TCM + FE | pack locales[] declared; next-intl installed in FE but dead; no translated strings anywhere |
| 3 | Advanced Search | **CORE-M** | SRCH | (duplicate of 9.8) |
| 4 | Bulk Operations | **CORE-S** | all | bulk exists on notifications/queue/search-index only; no generic bulk |
| 5 | Static Pages | **NO** | FE | marketing/legal content is not core |
| 6 | User Preferences | **LIVE** | IAM + COM |  |
| 7 | Admin Panel | **LIVE** | meru-dashboard | god view, tenants, packs, billing, flags, modules |
| 8 | Settings Management | **LIVE** | TCM | /tenant/settings + /tenant/branding |
| 9 | Scheduled Jobs | **KEY** | QUEUE + jobs | /jobs/tick works; @Cron is dead on Vercel and NO external scheduler is configured - all 13 jobs read overdue |
| 10 | Voice Transcription | **KEY** | AI | needs a Whisper/Deepgram key |
| 11 | Conversation Export | **CORE-S** | AI + DOC |  |


### Tally — GovernanceX (174 rows)

| Verdict | Meaning | Count | % |
|---|---|---|---|
| **LIVE** | Live in core | 64 | 37% |
| **PACK** | Config-pack authoring only (no code) | 17 | 10% |
| **SCHEMA** | Pack-schema extension + one generic engine | 15 | 9% |
| **CORE-S** | Core code - small | 39 | 22% |
| **CORE-M** | Core code - medium | 13 | 7% |
| **CORE-L** | Core code - large | 2 | 1% |
| **KEY** | Blocked on a credential only | 10 | 6% |
| **EXT** | Blocked on a commercial/government contract | 7 | 4% |
| **HOST** | Impossible on the current deployment | 5 | 3% |
| **NO** | Should not live in horizontal core | 2 | 1% |
| | **Total rows** | **174** | |

Live or pack-only (zero core code): 81 = 47%
Needs core code (S+M+L+SCHEMA): 69
Not an engineering problem (KEY+EXT+HOST+NO): 24

---

## 4. Immigration BRD — all 117 requirements

Same verdict key. `PACK+EXT` = the config pack is authorable now, but the
regulator connector behind it stays sandbox until licensed.

### BRD §5 — Portals & Roles

| # | BRD requirement | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Firm Admin Portal | **LIVE** | immistack /admin/* | 19 admin pages |
| 2 | Staff Portal | **LIVE** | immistack /staff/* | 6 pages |
| 3 | Client Portal | **LIVE** | immistack /client/* | 4 pages; client-role rows are server-scoped (32147ed) |
| 4 | Platform Owner Portal (God View) | **LIVE** | meru-dashboard | 12 pages; duplicate /platform console in immistack was deleted |
| 5 | RBAC across portals | **LIVE** | IAM | roles + PolicyGuard + pack roles[] |

### BRD §6 — Firm Initialization Wizard

| # | BRD requirement | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Firm profile (name, countries, size) | **LIVE** | TCM | POST /tenants + /tenant/settings |
| 2 | Per-country configuration (staff, visa categories, volume) | **PACK** | TCM | needs one pack per country; only au-immigration exists |
| 3 | Data migration - CSV import | **CORE-M** | INT (new import surface) | nothing exists. Needs papaparse/exceljs + a staging table |
| 4 | Data migration - HubSpot / Zoho / Salesforce | **CORE-L** | INT | three OAuth apps + field discovery; each is its own connector |
| 5 | Field mapping preview & validation before import | **CORE-M** | INT | dry-run diff before commit; the part that stops a bad import |
| 6 | Payments configuration (online/offline/hybrid, EMI) | **SCHEMA** | BILL/payments | payments has no plan or instalment model; needs pack paymentPlans[] |
| 7 | Document storage selection - platform S3 | **LIVE** | Storage | s3.provider.ts |
| 8 | Document storage selection - Google Drive | **CORE-M** | Storage | provider interface exists; needs googleapis driver + per-tenant OAuth |
| 9 | Document storage selection - Azure Blob | **CORE-M** | Storage | needs @azure/storage-blob driver |
| 10 | Branding setup (logo, colours, themes) | **LIVE** | TCM | GET/PUT /tenant/branding + BrandingProvider CSS vars |
| 11 | Email template branding | **KEY** | COM | template table is empty and unseeded |
| 12 | Invoice layout branding | **CORE-S** | BILL | no invoice PDF renderer |
| 13 | Automatic branding from a website URL | **CORE-M** | TCM + AI | was a setTimeout fake in the FE; needs real fetch + palette extraction |
| 14 | Module selection at onboarding | **LIVE** | TCM | PUT /tenants/me/entitlements, plan-capped |

### BRD §7 — Module Model

| # | BRD requirement | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Core modules always enabled | **LIVE** | TCM | CORE_MODULES in tenant-provisioning.service.ts |
| 2 | Optional/paid modules per tenant | **LIVE** | TCM + BILL | PLAN_MODULES map; plan is the ceiling |
| 3 | Feature-flag controlled | **LIVE** | TCM | /feature-flags CRUD |
| 4 | Billable per tenant | **KEY** | BILL | Stripe code shipped; /billing/checkout returns 503 without STRIPE_SECRET_KEY |
| 5 | Independently deployable modules | **NO** | - | single NestJS deployment; the config-pack model is the substitute and is the better answer |

### BRD §8 — Country Module Architecture

| # | BRD requirement | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Visa categories & workflows | **PACK** | TCM + WF | au-immigration has exactly ONE workflow (482 TSS) |
| 2 | Required document templates | **PACK** | TCM + DOC | 5 documentTypes in au-immigration; GET /documents/checklist reads them |
| 3 | Validation rules | **SCHEMA** | TCM + FORM | field-level validation exists; cross-field eligibility rules do not |
| 4 | Compliance checklists | **PACK** | TCM + DOC | documentTypes + workflow requiredDocuments |
| 5 | Application lifecycle states | **PACK** | WF | pack workflow steps + transitions |
| 6 | Government fee structures | **SCHEMA** | BILL/payments | nowhere to declare a fee schedule. Needs pack feeSchedules[] |
| 7 | Automated retrieval of official visa forms | **CORE-M** | Engine: Radar + DOC | radar crawls text, does not fetch and version forms |
| 8 | Required-document list sync | **CORE-M** | Engine: Radar + TCM | the radar->pack-diff pipeline (B14) is the mechanism, unbuilt |
| 9 | Regulatory update feed | **LIVE** | INT + Radar | /integrations/{cc}/regulatory-updates (sandbox) |
| 10 | Versioned storage with audit trail | **LIVE** | TCM + AUD | config packs are versioned + promote/pin; AUD hash-chained |
| 11 | AU: Student / PR / 485 / Tourist visa workflows | **PACK** | TCM | four workflows to author; none exist |
| 12 | AU: health insurance (OSHC) logic | **SCHEMA** | TCM | an eligibility rule with no home in the schema |
| 13 | AU: APF rules | **SCHEMA** | TCM | same |
| 14 | AU: VEVO integration | **EXT** | INT | adapter live in SANDBOX; live access needs registered-agent credentials |
| 15 | AU: visa status monitoring | **CORE-S** | Orchestration + INT | adapter + agent scaffolding exist; no monitor agent registered |
| 16 | AU: expiry alerts & automatic notifications | **SCHEMA** | WF + COM | needs pack alertRules[] |
| 17 | Canada country module | **PACK+EXT** | TCM + INT | IRCC adapter exists (sandbox); no ca-immigration pack |
| 18 | UK country module | **PACK+EXT** | TCM + INT | Home Office adapter exists (sandbox); no uk-immigration pack |
| 19 | New Zealand country module | **PACK+EXT** | TCM + INT | INZ adapter exists (sandbox); no nz-immigration pack |

### BRD §9 — CRM & Lead Management

| # | BRD requirement | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Manual lead entry | **LIVE** | CRM | lead entityType + /crm/entities |
| 2 | Website form intake | **LIVE** | FORM | public form submissions |
| 3 | WhatsApp intake | **KEY** | COM | no WhatsApp transport; needs Twilio or Meta Cloud API |
| 4 | Email parsing intake | **CORE-M** | COM | no inbound mail pipeline |
| 5 | Lead scoring | **SCHEMA** | CRM + AI | needs pack scoringModels[] |
| 6 | Visa recommendation engine | **SCHEMA** | AI + TCM | a rules+scoring problem, not a new module |
| 7 | Source attribution | **CORE-S** | CRM | no source/campaign field on lead |
| 8 | Conversion tracking | **CORE-S** | CRM + BI | lifecycle columns exist; no funnel report |

### BRD §10 — Case & Payment Workflow

| # | BRD requirement | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Consultation booking | **CORE-M** | TASK | /tasks/calendar/events + sync/:provider exist; no bookable-slot model |
| 2 | Payment verification | **LIVE** | payments | PATCH /payments/:id/settle, staff-only |
| 3 | Lead-to-client conversion | **LIVE** | CRM | entity lifecycle |
| 4 | Cost agreement generation | **CORE-M** | DOC | no document generation; needs pdf-lib + a template |
| 5 | Consultation & signup fees | **LIVE** | payments | integer minor units |
| 6 | EMI / instalment schedules | **SCHEMA** | payments | single-amount rows only. Needs paymentPlans[] + a schedule table |
| 7 | Stage-based payments | **SCHEMA** | WF + payments | pack workflow step type 'payment' EXISTS - WF just does not enforce it |
| 8 | Government fee tracking | **SCHEMA** | payments | no fee-type/disbursement distinction on the row |
| 9 | Payment-gated workflow progression | **CORE-S** | WF | the one enforcement point that makes the payment step real |
| 10 | Automatic case freeze on non-payment | **SCHEMA** | WF | an alertRule + a workflow guard |
| 11 | Admin override controls | **CORE-S** | WF + AUD | must be audited when used |

### BRD §11 — Document Management

| # | BRD requirement | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Unified storage API across providers | **LIVE** | Storage | interface is right; only S3 implemented |
| 2 | Visa-specific upload templates | **PACK** | DOC + TCM | documentTypes drive GET /documents/checklist |
| 3 | Mandatory document validation | **LIVE** | DOC | required flag + checklist. NOTE: an upload with no metadata.documentTypeKey never matches |
| 4 | Expiry & compliance alerts | **SCHEMA** | DOC + WF | document expiry is not modelled; needs alertRules[] |

### BRD §12 — Staff & Case Operations

| # | BRD requirement | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Visa assignment | **LIVE** | TASK + CRM |  |
| 2 | Draft preparation | **KEY** | AI + DOC | needs OPENAI_API_KEY and a seeded prompt library |
| 3 | Document requests | **LIVE** | DOC + COM |  |
| 4 | Status updates | **LIVE** | WF |  |
| 5 | Compliance file notes | **LIVE** | CRM + AUD | note entityType, hash-chained audit |
| 6 | Timestamped, user-attributed, audit-logged | **LIVE** | AUD | WORM triggers on audit_logs |

### BRD §13 — AI Automation & Orchestration

| # | BRD requirement | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | ChatGPT-style command bar in every portal | **CORE-S** | AI + FE | /ai/execute 500s today: ai_prompts is empty |
| 2 | Natural-language actions across modules | **CORE-M** | AI + Orchestration | no tool/function-calling layer over the 14 modules |
| 3 | Fetch cases / download docs / access client data by prompt | **CORE-M** | AI | same tool layer, and it must respect RLS + intra-tenant scoping |
| 4 | Generate drafts | **KEY** | AI | key + prompts |
| 5 | Trigger workflows by prompt | **CORE-S** | AI + WF |  |
| 6 | Personalised client communication | **SCHEMA** | AI + COM | sequences[] + templates |
| 7 | Payment reminders & follow-ups | **SCHEMA** | COM + payments | alertRules[] + sequences[] |
| 8 | Document request automation | **SCHEMA** | DOC + COM | checklist gap -> sequence |
| 9 | Status notifications | **LIVE** | WF + COM | needs the scheduler + mail key to actually leave the building |
| 10 | Auto task creation & SLA monitoring | **CORE-S** | TASK + WF | watchdog detects, does not act |

### BRD §14 — Communication Tracking

| # | BRD requirement | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Email channel | **KEY** | COM | Resend, needs key |
| 2 | SMS channel | **KEY** | COM | enum exists, deliberately fails loudly with no transport |
| 3 | WhatsApp channel | **KEY** | COM | same; Meta Business verification is the long pole |
| 4 | Internal notes | **LIVE** | CRM |  |
| 5 | Threaded conversation history | **CORE-S** | COM | notifications has no thread key - the documented gap |
| 6 | Compliance-grade file notes | **LIVE** | AUD |  |

### BRD §15 — Marketing & Growth

| # | BRD requirement | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Newsletter campaigns | **SCHEMA** | COM | as pack sequences[] on COM, NOT a new module |
| 2 | SEO reporting integrations | **NO** | - | belongs in the firm's own tools; not regulatory plumbing |
| 3 | Social media posting | **NO** | - | same |
| 4 | Lead attribution analytics | **CORE-S** | CRM + BI | the one piece that is genuinely core (see 9.7) |

### BRD §16 — Analytics & Reporting

| # | BRD requirement | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Firm dashboards: lead conversion | **CORE-S** | BI | widget engine live; the report definitions do not exist |
| 2 | Firm dashboards: revenue | **CORE-S** | BI + payments |  |
| 3 | Firm dashboards: visa success rates | **PACK** | BI | a pack kpis[] entry |
| 4 | Firm dashboards: staff productivity | **CORE-S** | BI + TASK |  |
| 5 | Platform: MRR / ARR | **KEY** | BILL | /billing/metrics live; needs Stripe data to be non-zero |
| 6 | Platform: tenant growth | **LIVE** | BI | /platform/stats |
| 7 | Platform: module adoption | **LIVE** | TCM | entitlements per tenant |
| 8 | Platform: country usage | **CORE-S** | BI |  |

### BRD §17 — Security & Compliance

| # | BRD requirement | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | RBAC | **LIVE** | IAM |  |
| 2 | Strict tenant isolation | **LIVE** | core/tenancy | non-BYPASSRLS role, ENABLE+FORCE RLS on 51 tables, rls:verify 10/10 |
| 3 | Encryption in transit & at rest | **LIVE** | infra + INT | TLS; AES-256-GCM for connector credentials. Per-tenant KMS still planned |
| 4 | Consent & authorization logs | **LIVE** | AUD |  |
| 5 | Full audit trails | **LIVE** | AUD | hash-chained + WORM triggers. True immutability still needs S3 Object Lock |

### BRD §18 — CI/CD, Hosting & Infrastructure

| # | BRD requirement | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | AWS multi-region, ECS/EKS, Aurora, CloudFront | **NO** | infra | currently Vercel + Neon. A deliberate decision to revisit, not a gap to code around |
| 2 | S3 document storage | **LIVE** | Storage |  |
| 3 | Git-based CI with automated build & test | **LIVE** | infra | CI gates on npm test + rls:verify |
| 4 | Environment-based deployments | **LIVE** | infra | dev/preview/prod on Vercel |
| 5 | Feature-flag driven releases | **LIVE** | TCM |  |
| 6 | Zero-downtime deployments | **LIVE** | infra | serverless by default |
| 7 | Always-on worker for realtime/queues | **HOST** | infra | the blocker behind every collaboration feature and the reason a scheduler is external |

### BRD §19 — Scalability & SaaS Readiness

| # | BRD requirement | Verdict | Meru home | Note |
|---|---|---|---|---|
| 1 | Multi-region support | **NO** | infra | tied to the hosting decision above |
| 2 | Feature-based pricing | **LIVE** | BILL + TCM | plan -> entitlements |
| 3 | Usage-based billing | **LIVE** | BILL | usage_records + /billing/usage |
| 4 | White-label support | **LIVE** | TCM | branding at runtime; custom domains still backlog |
| 5 | Country-agnostic extensibility | **PACK** | TCM | the whole four-layer model - held back only by there being 2 packs |

### Tally — Immigration BRD (117 rows)

| Verdict | Count |
|---|---|
| **LIVE** | 44 |
| **SCHEMA** | 17 |
| **CORE-S** | 15 |
| **CORE-M** | 12 |
| **PACK** | 9 |
| **KEY** | 9 |
| **NO** | 5 |
| **PACK+EXT** | 3 |
| **CORE-L** | 1 |
| **EXT** | 1 |
| **HOST** | 1 |
| **Total** | **117** |
---

## 5. The design: nine pack arrays + nine generic evaluators

This is how the remaining scope lands inside the 80/20 model instead of
breaking it. Each pack array is Layer 4 JSON; each evaluator is Layer 1 code
that has no idea which vertical it is serving.

| # | Pack vocabulary (Layer 4) | Evaluator (Layer 1) | Lives in | Size |
|---|---|---|---|---|
| 1 | `prompts[]` — key, category, system, citation policy | prompt resolver reads the pack before the DB | AI | S — **do first, it fixes a live 500** |
| 2 | `alertRules[]` — `{ on, when, severity, notify, escalateAfter }` | rule evaluator on `/jobs/tick`, writes notifications + tasks | WF (new `rules/` sub-module) | M — unblocks the most rows |
| 3 | `rules[]` — named json-logic expressions | shared expression evaluator used by FORM validation, WF transitions and `alertRules.when` | WF + FORM | S |
| 4 | `messaging.templates[]` / `messaging.sequences[]` | sequence runner: step, delay, condition, stop-on-reply | COM | M |
| 5 | `feeSchedules[]` + `paymentPlans[]` | schedule expander → `payment_schedule_items`; gov-fee vs firm-fee vs disbursement on the row | payments | M |
| 6 | `scoringModels[]` — weighted factors + bands | scoring evaluator returning `{score, band, contributions}` | AI | S |
| 7 | `relationships[]` — typed edges between entity types | one generic `entity_relations` table + traversal endpoint | CRM | S |
| 8 | `navigation[]` + `dashboards[]` | served through `/config-packs/effective/...`; the three FEs render nav from it instead of hardcoding | TCM | S |
| 9 | `importMappings[]` | import pipeline: upload → parse → map → **dry-run diff** → commit | INT (new `/integrations/import`) | M |

Two rules to hold while doing this, both learned the hard way in this codebase:

- **Every array must be optional and additive.** The last time this schema
  changed, `entityTypes` was stripped twice — once by the Zod schema and once
  by the loader's key list (`e8758da`) — and before that a `code` regex
  mismatch rejected *every* pack at boot, leaving `config_packs` empty while
  the docs said Layer 3/4 was live. Extend the Zod schema, the JSON Schema and
  the loader's key list **in the same commit**, and assert a round-trip test
  that a pack with all nine arrays survives load → DB → `effective/`.
- **No `eval`.** Use `json-logic-js`, which is declarative, serialisable and
  safe to accept from a pack that a non-engineer authored. An expression
  language with host access in a multi-tenant config pack is a sandbox escape
  with a JSON file for a payload.

### 5.1 Core work that is genuinely horizontal and not pack-shaped

Small, and each unlocks several rows:

| Item | Rows | Note |
|---|---|---|
| **Payment-gate enforcement in WF** | 3 | the pack step type `payment` already exists; WF just does not block on it. This is the whole "case freeze on non-payment" feature |
| **`threadKey` on notifications + `GET /communications/threads`** | 2 | one column, one grouped query. The documented COM gap |
| **Generic comments** (promote CRM `note` to any entity) | 3 | tasks have comments; nothing else does |
| **SLA watchdog actions** (`sla-watchdog.service.ts:156,170`) | 5 | it detects breaches and then does nothing. Escalation, alerts, TAT all sit on this |
| **Wire Elasticsearch behind the search facade** | 4 | a finished service (`src/search/elasticsearch/`) that nobody imports; the facade is Postgres `ILIKE` |
| **TAT recording** (per-stage clock on workflow instances) | 3 | prerequisite for all TAT analytics |
| **Seed `notification_templates` + `ai_prompts` from packs** | 6 | see §0.2 |
| **Retention enforcement** (`compliance.retentionYears`) | 1 | declared in packs, enforced nowhere |
| **Storage drivers: Google Drive, Azure Blob** | 2 | the provider interface is already correct |
| **Document generation** (`pdf-lib`) | 2 | cost agreements, invoice layouts |
| **Outbound webhooks** | 1 | `NotificationType.WEBHOOK` exists with no dispatcher |
| **EU CFSP + UK OFSI sanctions lists** | 1 | free sources; only OFAC SDN + UN are ingested |

### 5.2 What should **not** be built in core

- **A MARKETING module.** Newsletters are `messaging.sequences[]` on COM. SEO
  reporting and social posting are not regulatory plumbing and belong in the
  firm's own tools or a vertical app — `GET /marketing/campaigns` is a category
  error, and this is the decision the handoff doc asked for.
- **Independently deployable modules** (BRD §7). The config-pack model is the
  substitute and is the better answer for this product.
- **AWS ECS/EKS/Aurora/CloudFront** (BRD §18) as a *gap to close*. It is a
  hosting decision to make on its merits — see §7.1 — not a missing feature.
- **Native mobile apps** and **static marketing pages**.

---

## 6. Strategy — ordered by cost, not by spec order

### Phase A — Unblock what is already built (days, not weeks)

Nothing here is new architecture. It flips ~19 rows from broken to working and
it is the highest return on this list by a wide margin.

1. Set `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` + the three price IDs
   (**test mode first**).
2. Set `RESEND_API_KEY` + `MAIL_FROM` on a verified domain. Until this lands,
   a provisioned tenant admin never receives their invite — the platform
   cannot onboard a customer.
3. Set `OPENAI_API_KEY`. Every AI row depends on it.
4. Point an external scheduler at `POST /jobs/tick?scope=fast` with
   `CRON_SECRET`. All 13 jobs currently read `overdue` because nothing runs
   them; that includes sanctions ingestion.
5. **Seed the prompt library and notification templates** — pack-driven per §5
   item 1, so this is done once and inherited by every vertical.
6. Fix the stale `notImplemented('PUT /forms/:id')` seam (§0.3) and the
   `status === 'active'` assumption (§0.1).
7. Ingest EU CFSP + UK OFSI lists (free, no credential).

### Phase B — The nine pack arrays + nine evaluators (2–3 weeks)

§5, in the order given there. Prompts first (fixes a live 500), then
`alertRules` + `rules` (most rows), then messaging, fees, scoring, the rest.
Ship each array with its evaluator and a round-trip pack test in one commit.

### Phase C — Pack authoring (2–3 weeks, parallel, and mostly not engineering)

This is where the immigration BRD actually lives, and it needs a domain author
more than a developer.

- **`au-immigration` has zero `entityTypes` and exactly one workflow.** The
  banking pack has nine entity types driving nine GovX pages; the immigration
  pack has none. Layer 4 for the immigration vertical is essentially empty,
  which is why ImmiStack needed hardcoded pages. Author `entityTypes` plus the
  Student / PR / 485 / Tourist workflows.
- **`ae-banking` is missing `obligation` and `breach`** from `entityTypes` even
  though both exist in the code enum — so the obligations and breach pages have
  no vocabulary source.
- Author `ca-immigration`, `uk-immigration`, `nz-immigration`, `ksa-banking`,
  `qa-banking`. The adapters already exist; only the JSON is missing.

### Phase D — The remaining core gaps (3–4 weeks)

§5.1, then the medium items: CSV import + mapping preview, consultation
booking, HubSpot/Zoho/Salesforce importers, WebAuthn, fraud-pattern store,
email analytics.

### Phase E — Decide the realtime host (a decision, then ~1 week)

Five collaboration rows and push notifications wait on this. Options in §7.1.

### Phase F — Contracts (long lead, start the paperwork now)

WorldCheck, Dow Jones, Finacle, VEVO/ImmiAccount, IRCC, UK Home Office, INZ,
CBUAE Open Finance, SAMA, QCB. Every one of these keeps its **sandbox badge**
until real credentials are installed. A UI that implies live regulator data is
the worst failure mode this product has.

---

## 7. Dependencies — libraries, APIs and credentials

### 7.1 Decisions I need from you

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 1 | **Realtime host** for chat/presence/collaborative editing | (a) hosted provider — Ably or Pusher; (b) always-on Node service on Fly.io/Railway alongside Vercel; (c) drop realtime from v1 | **(a) Ably** — no infra to run, works with a serverless API, and the five rows are worth less than a second deployment target |
| 2 | **Scheduler** | (a) Upstash QStash; (b) cron-job.org; (c) re-enable GitHub Actions; (d) Vercel cron (daily only — inadequate) | **(a) QStash** — per-minute cadence, retries, signed requests |
| 3 | **Marketing module** | build it in core / pack `sequences[]` only / out of scope | **`sequences[]` only** (§5.2) |
| 4 | **AWS migration** (BRD §18) | stay Vercel+Neon / move to ECS+Aurora | **Stay for now**; revisit when a client contract requires data residency Neon cannot give |
| 5 | **OCR** | cloud Vision (current) / self-host Tesseract | **Cloud** — Tesseract on serverless is a bad fit for large scans |

### 7.2 Credentials I need from you (nothing works without these)

**Free / already yours — just needs setting:**

| Env var | For | Consequence today |
|---|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER/_PROFESSIONAL/_ENTERPRISE` | BILL | `/billing/checkout` → 503. **Test mode first**; never paste the secret in chat or git |
| `RESEND_API_KEY`, `MAIL_FROM` (verified domain) | COM | tenant invites only log a link — no customer can be onboarded |
| `OPENAI_API_KEY` | AI, DocIntel OCR, radar | every AI feature disabled |
| `CRON_SECRET` + a scheduler URL | QUEUE, ingestion | 13/13 jobs overdue |

**Paid API keys, no negotiation needed (~$20–200/mo each):**

| Service | For | Notes |
|---|---|---|
| Ably or Pusher | realtime (decision 1) | free tier likely sufficient to start |
| Upstash QStash | scheduler | free tier sufficient |
| Twilio *or* Meta WhatsApp Cloud API | SMS + WhatsApp channels | **Meta requires Business verification — start early, it is the long pole** |
| Deepgram *or* OpenAI Whisper | voice transcription | Whisper if the OpenAI key is already set |
| Elastic Cloud | wire the finished ES service | or self-host; the code is written either way |
| DocuSign *or* Dropbox Sign | e-signature, digital certificates | |
| AISStream.io *or* Spire/MarineTraffic | AIS beyond what is ingested now | AISStream is free but websocket-only — needs the always-on host from decision 1 |
| Google Cloud OAuth client | Google Drive storage driver | per-tenant consent flow |
| Azure storage account | Azure Blob driver | |
| HubSpot / Zoho / Salesforce developer apps | CRM import | three OAuth apps, one per importer |

**Commercial contracts — cannot be coded around, start now:**

Refinitiv WorldCheck One · Dow Jones Risk & Compliance · Finacle (needs the
bank client's own environment) · an adverse-media/PEP feed · HS-code price
benchmark data.

**Government access — licensing, not code:**

AU VEVO/ImmiAccount (registered migration agent or approved integrator) ·
IRCC · UK Home Office right-to-work · NZ INZ · CBUAE Open Finance
certification · SAMA · QCB. See `docs/REGULATOR_API_ACCESS.md`.

### 7.3 Free / open data sources (no credential, just ingestion code)

- **Sanctions:** OFAC SDN ✅ loaded · OFAC Consolidated (add) · UN Consolidated
  ✅ loaded · EU CFSP FSF XML (add) · UK OFSI/HMT CSV (add)
- **Legislation for Radar:** AU Federal Register of Legislation ·
  legislation.gov.uk · Canada Gazette · CBUAE rulebook (bot-blocked, crawl
  server-side) · SAMA · QCB

### 7.4 npm packages to add

| Package | For |
|---|---|
| `json-logic-js` | pack `rules[]` / `alertRules[].when` — declarative and safe. **Not** an eval-based evaluator |
| `papaparse` + `exceljs` | CSV/XLSX import, bulk screening import |
| `pdf-lib` | cost agreements, invoice PDFs |
| `rrule` + `ical-generator` | consultation booking, calendar sync |
| `@azure/storage-blob`, `googleapis` | storage drivers |
| `@simplewebauthn/server` | biometric auth / passkeys |
| `ably` (or `@nestjs/websockets` + `socket.io` if decision 1 goes self-hosted) | realtime |

Already present and sufficient: `stripe`, `resend`, `openai`,
`@elastic/elasticsearch`, `talisman` (screening phonetics), `ais-decoder`,
`geolib`, `cron-parser`, `otplib`, `bull`, `zod`. **`next-intl` is installed in
the frontends but dead** — multi-language needs string extraction, not a
library.

---

## 8. What I would do first, in one paragraph

Set the four credentials and the scheduler (§6 Phase A) — that alone turns
~19 rows from broken to working and is the difference between a platform that
can onboard a paying customer and one that cannot. In the same week, seed the
prompt library and notification templates from the packs, because two features
recorded as shipped are currently returning 500 and empty lists for every
tenant. Then extend the pack schema with the nine arrays and their evaluators,
because until that exists every remaining feature request has to be answered
with vertical code inside `src/`, and that is the one thing that would actually
break this architecture. Pack authoring for immigration can run in parallel and
does not need a developer — `au-immigration` having zero `entityTypes` is the
single biggest reason ImmiStack needed 30 hardcoded pages.
