# Meru / GovX / ImmiStack — Master Gap Analysis & Build Plan

> Compiled 2026-08-07 from: every document in `claude-documents/` (Meru Blueprint v2, GovernanceX BRD + Tech Spec + Proposal, ImmiStack 55KB canonical prompt + Immigrow v2 BRD + frontend plan + marketing site), full code inventory of `meru-core` (234 files, ~230 endpoints) and `meru-core-fe` (3 Next.js apps).

---

## 0. Locked decisions

| Decision | Choice |
|---|---|
| DB topology | **One NestJS backend, three Neon databases**: `meru` (control-plane: tenants, users, billing, config packs, flags, platform audit), `govx` (GRC domain data), `immistack` (immigration domain data). RLS enforced inside each vertical DB. |
| Tenant creation | **Admin-provisioned only** from Meru dashboard → invite email → tenant admin sets password → in-app onboarding. No public signup. |
| Branding | **In-app onboarding wizard** on first login (logo, colors, timezone, team invites) applied via CSS variables; Meru dashboard can view/override. No custom domains yet. |
| Billing | **Stripe plans + seats**; plan → entitlements (module/country toggles). Usage metering (already built) layered later. |
| Regulator connectors | Per-tenant **connector registry**: GovX tenants pick UAE CBUAE (primary), SAMA (KSA), QCB (Qatar), CBB (Bahrain); ImmiStack tenants pick AU Home Affairs, CA IRCC, UK Home Office, NZ INZ. All 8 adapters already exist as sandbox-mode code. |

---

## 1. Where things actually stand (evidence-based)

### 1.1 Backend `meru-core` — solid spine, missing money + delivery + multi-DB

**Genuinely done:** IAM (login/refresh/MFA-TOTP/SAML/invites/password-reset/API keys/sessions), tenancy+RLS (fail-closed, `rls:verify` passing, `runAsSystem`/`runAsGod` audited), config-pack loader + full CRUD/promote/pin API, forms, tasks, storage (S3 multipart/versions), audit hash-chain, AIS vessel ingestion (real NMEA decoding), 4 AI engines with real algorithms (screening: Jaro-Winkler/Levenshtein/Soundex/Arabic transliteration; doc-intel: Vision + fraud signals; vessel: geofencing/dark-period; radar: scheduled diffing), 8 government adapters (shape-correct sandbox mocks), Resend mail for IAM flows.

**Top backend gaps:**
| # | Gap | Evidence |
|---|---|---|
| B1 | **No Stripe** — cannot collect payment; no webhook route | `stripe` absent from package.json; billing entities/metering exist |
| B2 | **Single database only** — no multi-connection support | one `TypeOrmModule.forRootAsync`; RLS bound in `rls.datasource.ts` |
| B3 | **No global auth guard** — new controllers are public by default | opt-in `@UseGuards` per controller |
| B4 | **PolicyGuard live mock** — defaults every tenant to `vertical:'fintech'` | `src/iam/guards/policy.guard.ts:29`; `vertical-policy.service.ts` is a stub |
| B5 | **COM never delivers** — notifications write DB rows, no transport | no MailService/SMS/WhatsApp import in `notifications.service.ts` |
| B6 | **Screening has algorithms, no data** — hardcoded OFAC samples | `screening.engine.ts:108` `BUILTIN_WATCHLISTS` |
| B7 | **No per-tenant connector enablement/credentials** — adapters are global singletons | `src/integrations/` |
| B8 | **`@Cron` dead on Vercel** — billing sweep, SLA watchdog, radar never fire unless mirrored into `/jobs/tick` | `.github/workflows/cron.yml` only hits `jobs/tick` |
| B9 | **~Zero tests; CI runs neither `npm test` nor `rls:verify`** | 2 scaffold spec files |
| B10 | Only 2 config packs (`ae/banking`, `au/immigration`) — no KSA/QA/CA/UK | `packages/config-packs/` |
| B11 | SRCH bifurcated: stub `ILIKE` facade used everywhere; complete ES service used by nobody | `src/search/` |
| B12 | SLA watchdog responses are TODOs; DOC text-extraction placeholder; no e-signature | `sla-watchdog.service.ts:84-92` |
| B13 | Stray duplicate `src/iam/entities/session.entity 2.ts` declaring `@Entity('sessions')` — glob-load hazard | untracked file |
| B14 | Regulatory Radar doesn't draft config-pack diffs/PRs (spec promise) | `regulatory-radar.engine.ts` |

### 1.2 Frontend `meru-core-fe` — three very different states

| App | Live coverage | Verdict |
|---|---|---|
| **governancex** | ~18 / 21 pages live | **Nearly finished.** Gaps: settings save unwired (hooks exist), GovAI chat is a canned keyword dictionary, search falls back to inline mock, tasks kanban seeds from mock, notification-settings/help hardcoded, RFI update blocked on missing `PUT /forms/:id`. |
| **meru-dashboard** | 2 / 10 pages live | **Design-complete shell.** Service layer already written for config-packs CRUD/promote, billing plans/metrics, tenant stats — **zero call sites**. God-view, modules, billing, config-packs, feature-flags pages all hardcoded. **No tenant-creation flow exists at all** — the app's core purpose. |
| **immistack** | ~1 / 35 pages live | **Rich prototype.** Only login, onboarding step-1 signup, and kanban stage-PATCH hit the backend (and the kanban drags mock IDs into real PATCHes). 33 pages render inline `const MOCK = [...]`. Onboarding wizard collects 7 steps, persists 1. Branding page saves nothing. Duplicate mock "platform portal" that belongs in meru-dashboard. Broken sidebar links (`/admin/settings/billing`, `/platform/incidents`, `/staff/calendar`…). next-intl installed but dead. |

**Cross-app:** no SSO between portals; `packages/ui` is dead code (nothing imports `@meru/ui` — everything triplicated); no runtime tenant theming anywhere; MFA login is a dead end in all three (no `/auth/mfa/verify` screen); tokens in localStorage (known, accepted for now); 7 untracked `… 2.*` macOS duplicate files.

### 1.3 Docs vs reality (headline drift)
- CLAUDE.md/TRD promise tRPC, Stripe, WhatsApp/SMS delivery, OCR in DOC, radar→PR pipeline — none exist.
- GovernanceX docs describe a *different stack* (tRPC/Drizzle/MySQL, 216 tables, no tenancy, no billing). Treat those docs as the **feature checklist**, not the architecture: the Meru port implements their 21 modules on meru-core. Current governancex app covers ≈ 12 of 21 module areas (sanctions, trade-finance/vessel/TBML, obligations/breach, tasks/kanban, documents, audit, KPIs, reports, RFI-partial, regulatory intel, agents, users). **Not yet ported:** WorldCheck/Dow Jones feeds, email automation & A/B testing, Finacle sync, turnover monitoring, knowledge base/training, collaboration chat/presence, milestones/roadmap, voice transcription.
- ImmiStack 55KB spec vs app: shell/design ≈ done; data layer ≈ not started. Marketing-site-only features (trust accounting, commission tracking, Xero/QuickBooks, DocuSign, Form 80/1221/956 autofill, multi-office) → **explicitly deferred to post-v1 backlog**.

---

## 2. The build plan — phased, ordered by dependency and urgency

### Phase 0 — Hygiene & security gates (≤1 day, do first)
1. Delete `src/iam/entities/session.entity 2.ts` + the 7 `… 2.*` duplicates in meru-core-fe.
2. **Global `APP_GUARD`** (JWT + PolicyGuard) with `@Public()` decorator for health/login/webhooks; remove per-controller opt-in footgun. (B3)
3. Fix `policy.guard.ts:29` mock; make `VerticalPolicyService` read the tenant's real vertical. (B4)
4. CI: add `npm test` + `rls:verify` (against a Neon branch) as required steps. Seed the test suite with tenancy + auth guards tests. (B9)
5. FE: deconflict dev ports in scripts (3000/3001/3002); fix immistack broken sidebar links; remove immistack's duplicate `/platform/*` portal (redirect to meru-dashboard).

### Phase 1 — Platform spine: 3 Neon DBs + entitlements (week 1–2) ← everything else depends on this
6. **Three-database split** (B2):
   - `meru` DB: users, tenants, roles, sessions, auth_tokens, api_keys, config_packs, feature_flags, tenant_settings, billing_*, platform audit_logs.
   - `govx` / `immistack` DBs: identical vertical schema (crm entities, cases/tasks/documents/forms/workflows/notifications/storage/audit, integrations data, vessel_positions in govx).
   - Implementation: named TypeORM DataSources; a `VerticalConnectionResolver` picks the DataSource from the tenant's vertical (JWT claim / X-Tenant-ID); apply the existing `applyRlsToDataSource` + `FORCE RLS` migrations to **each** vertical DB; `rls:verify` runs against all three.
   - Split migrations; `DATABASE_URL[_APP]` becomes `MERU_DB_URL[_APP]`, `GOVX_DB_URL[_APP]`, `IMMISTACK_DB_URL[_APP]`.
7. **Entitlements service** (TCM): plan + per-tenant module/country toggles → `GET /tenants/me/entitlements`; enforced server-side by PolicyGuard, consumed by all three FEs for nav/module gating.
8. **Tenant provisioning v2** (extend existing `tenant-provisioning.controller`): create tenant with `{vertical, plan, country_modules[], connectors[]}` → provisions in correct DB, pins config pack, invites admin (existing invite + Resend flow), suspend/resume, delete-guard. Impersonate via existing `runAsGod` (already audit-logged).
9. **Connector registry** (B7): `tenant_integrations` table (adapter code, enabled, encrypted credentials, sandbox/live flag) + endpoints to list available adapters per vertical, enable/disable per tenant. This is the "choose UAE / SAMA / QCB" and "choose AU / CA / UK" feature.
10. Config packs: author `ksa/banking.json`, `qa/banking.json`, `ca/immigration.json`, `uk/immigration.json` (B10) — loader/validator already works.

### Phase 2 — Meru dashboard becomes real (week 2–3, parallel with late Phase 1)
11. Wire the **already-written services**: config-packs CRUD/promote/deactivate UI, billing metrics, tenant stats, live god-view stats (replace hardcoded arrays).
12. **Tenant creation wizard** (the "create GovX/ImmiStack account" flow): vertical → plan → country modules & connectors → admin email → invite sent. Reuse immistack's onboarding step components as the pattern.
13. **Tenant detail page**: stats, entitlement toggles (Odoo-style module grid per tenant with pricing badges), branding view/override, billing status, suspend/impersonate actions.
14. Feature-flags page → real `feature_flags` API (entity exists; add controller if missing).
15. Odoo-style home: app-grid of the 14 modules + 4 engines with per-tenant adoption stats.

### Phase 3 — Stripe billing (week 3–4) (B1)
16. Backend: Stripe customers/subscriptions/seats, `POST /billing/webhook` (public + signature-verified), checkout/customer-portal links, sync plan→entitlements on webhook. Keep existing invoice/usage models as the internal ledger.
17. Meru dashboard: plan assignment in wizard + tenant detail; invoices list; MRR/ARR on god-view.
18. Mirror the invoice-generation cron into `/jobs/tick` (B8, applies to SLA watchdog + radar too).

### Phase 4 — GovX to production quality (week 4–5)
19. Finish the 5 unwired surfaces: settings persistence (hooks exist), real GovAI chat → `POST /ai/execute` (citation-enforced), remove search/tasks/SAR/regulatory mock fallbacks, notification-settings persistence; add backend `PUT /forms/:id` to unblock RFI update.
20. **Connector picker UI** in GovX settings/integrations: shows CBUAE / SAMA / QCB / CBB from the registry, enable + credential entry, sandbox badge until live credentials exist.
21. Screening data (B6): scheduled ingestion of open OFAC SDN / UN / EU consolidated lists into a `watchlists` table; engine reads DB instead of hardcoded samples.
22. COM transport (B5): notifications dispatch through Resend (email) via `/jobs/tick`; SMS/WhatsApp stubbed behind the same interface.

### Phase 5 — ImmiStack wiring (week 5–8, the long pole)
Wire mock pages to real endpoints in this order (each batch = swap inline `const MOCK` for the TanStack hooks + `QueryBanner` pattern GovX already proved):
23. Cases + Kanban (fetchCases exists, unused; fix mock-ID drag bug) → Clients/Leads (`/crm/entities`) → Client/Case detail tabs.
24. Tasks, Documents (upload/request/checklists), Communications (email via COM; WhatsApp later), Staff (`/iam/users` — GovX pattern).
25. Payments: client-payment ledger on billing entities + Stripe payment links; government-fee tracking table.
26. Analytics dashboards → `/analytics/*`; AI home → `POST /ai/chat` streaming.
27. Onboarding wizard: persist **all 7 steps** to `POST /tenants/onboard` (extend DTO: countries, payment mode, storage choice, branding, modules) — but per the locked decision it runs *post-invite* as first-login onboarding, not public signup.
28. Country modules: AU (VEVO monitoring vs Home Affairs adapter), CA, UK checklists/workflows from config packs; connector picker same as GovX.

### Phase 6 — Branding & white-label runtime (week 8–9)
29. Backend: `GET/PUT /tenant/branding` (tenant_settings) + logo upload via storage module.
30. Both SaaS apps: first-login onboarding wizard (branding step) writes it; root layout injects CSS variables + logo from tenant branding; client portal shows firm logo ("powered by ImmiStack" footer). Meru dashboard renders/overrides it on tenant detail.
31. Optional later: URL-based theme extraction (currently a `setTimeout` fake), custom domains — backlog.

### Phase 7 — Hardening & spec debt (ongoing)
32. Test suite: RLS cross-DB, entitlements, billing webhooks, provisioning E2E; smoke scripts already exist (`smoke:*`).
33. MFA verify screen in all three FEs (backend TOTP already done).
34. SRCH: wire the finished Elasticsearch service behind the search facade (B11); SLA watchdog actions (B12); radar → config-pack diff drafts (B14).
35. Consolidate `packages/ui` or delete it (currently dead) — recommend delete now, extract later when patterns stabilize.
36. Update CLAUDE.md/docs to match reality (tRPC claim, directory names, Stripe columns).

### Phase 8 — Full GovX feature parity: the remaining 143-feature modules (week 9–14)
Scope change 2026-08-07: the full 21-module GovernanceX feature set is **in scope**, ported onto meru-core (not the legacy tRPC/MySQL stack). Remaining module groups, in build order:
37. **Match review & rescreening**: True-Match/False-Positive disposition workflow, scheduled rescreening jobs, bulk CSV/Excel import screening — extends the existing screening engine + WF module.
38. **Knowledge base & training**: articles, training modules, progress tracking (CRM polymorphic entities + DOC).
39. **Email automation & RFI advanced**: RFI templates/scheduler/SLA/A-B testing/auto-follow-up, sender analytics — on COM once transport lands (Phase 4).
40. **Collaboration**: threaded comments, activity feed, team chat, presence (WebSocket gateway — new; NestJS `@nestjs/websockets`).
41. **Turnover & financial monitoring** + **Finacle/core-banking sync** (adapter-pattern like gov adapters; sandbox until a bank client provides access).
42. **Milestones/roadmap, risk workshop, voice transcription** (AI gateway speech-to-text), mobile PWA polish.
43. **WorldCheck / Dow Jones** premium screening feeds — adapter stubs behind the connector registry; live only when licensed.

### Phase 9 — AI agents & regulatory listening in ALL THREE apps (week 10–14, overlaps P8)
Scope change 2026-08-07:
44. **Regulatory Radar sources registered per vertical**: CBUAE rulebook (incl. the API/Open Finance section at rulebook.centralbank.ae — site blocks bots, radar crawls server-side with rotating headers), SAMA, QCB, AU Home Affairs/legislation, IRCC, UK Home Office. Radar output → SME review queue UI in **meru-dashboard** (approve → config-pack diff → promote).
45. **GovX**: agents page already live (`/agents`); add agent types from the BRD enum (REGULATORY_INTELLIGENCE, CONTROL_TESTING, RISK_ASSESSMENT, VENDOR_DUE_DILIGENCE) with schedules + human-in-the-loop approvals via orchestration module.
46. **ImmiStack**: AI home (`POST /ai/chat` streaming) + case-level agents (document-checklist watchdog, VEVO/status monitor, payment-reminder agent) via orchestration + `/jobs/tick`.
47. **Meru dashboard**: agent fleet view across tenants (orchestration `/agents` + `/health` already live), radar review queue, citation-coverage metrics.

### AU migration APIs — reality check (honest constraint)
The AU Home Affairs adapter exists and is shape-correct, but **VEVO/ImmiAccount APIs require Australian government-approved access** (registered migration agent / approved integrator credentials). Plan: keep sandbox mode as default, build the connector-registry credential slot now, and file for access — same pattern for CBUAE Open Finance certification, SAMA and QCB. No fake "live" claims; each connector shows a sandbox badge until real credentials are installed.

### Stripe key handling (received 2026-08-07)
A **live publishable key** was provided. Policy: publishable keys are frontend-safe but Phase 3 ships against **Stripe test mode** first; the live `pk_live_…` goes into Vercel env (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`) only at go-live. The **secret key must never appear in chat or git** — set it directly in Vercel/backend env as `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`.

**Still-deferred backlog (not scheduled):** ImmiStack trust accounting, commission tracking, Xero/QuickBooks two-way sync, DocuSign, Form 80/1221/956 autofill, multi-office partitioning, native mobile apps; Meru marketplace; SOC2 audit tooling.

---

## 3. Verification per phase
- **P0/P1:** `npm run rls:verify` × 3 DBs; new guard test proves unauthenticated 401 on every non-`@Public` route; CI green.
- **P2:** create a GovX and an ImmiStack tenant end-to-end from the dashboard → invite email arrives (Resend) → admin logs into the right app → sees only entitled modules.
- **P3:** Stripe test-mode checkout → webhook flips plan → entitlements change live.
- **P4/P5:** each wired page: empty-DB state renders honestly (no mock leakage with `ALLOW_MOCKS` unset), then seeded-data state; screening returns real OFAC hits.
- **P6:** two tenants on the same app render different logos/colors.
