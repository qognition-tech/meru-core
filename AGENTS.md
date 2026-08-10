# AGENTS.md — where Meru Core actually stands

> Current state, verified against the running system rather than against
> documentation. Architecture and rules are in [CLAUDE.md](CLAUDE.md); these two
> files are the entire documentation surface.
>
> *Last verified: 2026-08-11 — 299 unit tests green, 785 API contract checks
> passing across all 297 operations, 31,579 sanctions entries per database, ten
> config packs, all three databases on 32 migrations.*
>
> **DEPLOYED 2026-08-11.** `main` and `production` are at `c05cadc` and live at
> `meru-core.vercel.app` — 248 paths / 297 operations, 10 config packs seeded,
> 785 contract checks passing against production, tenant isolation 10/10 over
> HTTP.
>
> `npm run rls:verify` cannot be run locally: it needs `DATABASE_APP_URL`, and
> `vercel env pull` returns encrypted values **blank**, so a pulled `.env` looks
> like the variable is unset when it is not. Verify isolation against the
> deployment with `BASE_URL=… bash scripts/smoke/cross-tenant.sh`, which proves
> the same property over HTTP with two real tenants.

---

## 1. Scope, measured

Two specifications drive this product: the GovernanceX features report (**174
rows**, marketed as "143 feature modules") and the Qognition immigration BRD
(**117 rows**). Every row was mapped onto the 14 modules, the 4 engines and the
pack schema, then checked against the live deployment.

| Verdict | GovX 174 | BRD 117 |
|---|---|---|
| Live in core | 64 (37%) | 44 (38%) |
| Config-pack authoring only, zero code | 17 | 12 |
| Pack-schema extension + generic evaluator | 15 | 17 |
| Core code, small | 39 | 15 |
| Core code, medium | 13 | 12 |
| Core code, large | 2 | 1 |
| Blocked on a credential only | 10 | 9 |
| Blocked on a commercial/government contract | 7 | 4 |
| Impossible on this deployment | 5 | 1 |
| Should not live in horizontal core | 2 | 5 |

**~47% of both specs is satisfied or needs nothing but JSON.** Only 3 rows out
of 291 are large engineering. The bottleneck was never module count — it was
that the pack schema had no vocabulary for 32 of the rows, so each could only
have been built as vertical code inside `src/`, which is the one thing that
would break the architecture.

**That bottleneck is now cleared: all nine pack arrays ship with their
evaluators** (§3), and the packs are restructured into vertical bases with
country overlays, so adding a country is one small file rather than a copy of
the whole vertical.

### 1.1 What the "143 features" document claims that is not true

A circulating "GovernanceX — Comprehensive Features Report" claims 143 feature
modules and 216 database tables, all operational, on a React 19 / Express /
tRPC / MySQL-TiDB / Drizzle stack. **That does not describe this system.** Meru
is Next.js / NestJS / Postgres-Neon / TypeORM. Of 38 named features checked
against the live spec, 4 had a backing route.

Genuinely absent: WorldCheck, Dow Jones, Finacle, adverse media, PEP, TBML
scoring beyond the current heuristics, price benchmarking, fraud-pattern
matching against history, email A/B testing, voice transcription, biometric
auth, digital certificates.

Nine of the names *do* exist as GovX pages — vendor-dd, control-testing,
risk-workshop, roadmap, knowledge-base, training, turnover, rfi, match-review —
built as UI over the generic `/crm/entities?type=X` resource. That is the
correct architecture, and it is not the described capability.

Five claims are **architecturally impossible on this deployment**, not merely
unbuilt: real-time collaboration, team chat, workspace collaboration, user
presence and collaborative editing all need a held-open connection, and Vercel
functions terminate per invocation.

If that document is being used for scoping or sales, the gap between it and the
running system is large, and the frontend is where a customer sees it.

---

## 2. The API surface

**297 operations across 248 paths** — 22 added since the last deploy, none
removed or renamed, so nothing built against the previous surface breaks.

Added: pack navigation and dashboards (4), communications threads (5), record
comments (3), entity relations and blockers (4), scoring (2), import (2), TAT
(2). Three existing endpoints gained fields additively:
`watchlist-status.lists[]`, `provenance` on every regulator response, and
`threadKey`/`direction` on notifications. The frontend contract for all of it is
`meru-core-fe/BACKEND-CHANGES-2026-08-11.md`.

Counts by prefix (pre-deploy figures, for shape rather than precision):

| Prefix | Routes | Prefix | Routes |
|---|---|---|---|
| `integrations` | 45 | `notifications` | 12 |
| `auth` | 16 | `billing` | 12 |
| `tasks` | 15 | `analytics` | 11 |
| `storage` | 15 | `crm` | 9 |
| `elasticsearch` | 15 | `workflows` | 8 |
| `tenants` | 14 | `engines` | 8 |
| `config-packs` | 14 | `orchestration` | 7 |
| `queue` | 13 | `jobs` | 7 |
| `forms` | 13 | `audit` | 7 |
| `documents` | 13 | `payments` | 5 |
| | | `communications` | 5 |

`npm run smoke:sweep` walks the whole OpenAPI document against a live instance:
auth posture on every operation, envelope shape and 5xx on reads, junk-body
validation on writes, and literal/param route shadowing. It exits non-zero on
any failure, so it gates a deploy.

---

## 3. Shipped, and what each one actually fixed

### 3.1 The nine pack arrays (Layer 4 → Layer 1)

| Array | Evaluator | Fixed |
|---|---|---|
| `prompts[]` | pack-before-DB resolver | `/ai/execute` returned **HTTP 500** for every tenant — `ai_prompts` was empty and unseeded |
| `rules[]` | `RuleEvaluatorService` | three condition languages that would have disagreed about `null` |
| `alertRules[]` | `AlertRuleService` sweep | 11 separately-named alert features become one loop |
| `messaging.*` | `SequenceRunnerService` | 8 email-automation rows; `notification_templates` was empty too |
| `fees[]`, `paymentPlans[]` | schedule expander + WF payment gate | EMI, gov-fee/disbursement provenance, case freeze on non-payment |
| `scoringModels[]` | `ScoringEngine` | lead scoring, visa recommendation, risk scoring — one weighted sum |
| `relationships[]` | `entity_relations` + traversal | "what blocks this?" was unanswerable; the old jsonb column read one way only |
| `navigation[]`, `dashboards[]` | `PackUiService`, `PackDashboardService` | three hardcoded sidebars; KPIs that declared a target and computed nothing |
| `importMappings[]` | `ImportService` | no way to bring a firm's existing book of clients in at all |

**All nine ship.**

Packs are at **v2.1.0** and restructured into vertical bases + country
overlays: `verticals/{grc,immigration}.json` plus `countries/{ae,sa,qa,bh}-grc`
and `countries/{au,ca,uk,nz}-immigration` — **ten packs**. GRC carries 11 entity
types (including `obligation` and `breach`, which existed in the code enum and
in no pack); immigration carries 6, where it previously declared **zero** —
the single reason that portal needed ~30 hardcoded pages. Twelve country
workflows.

### 3.2 Tenant isolation

Implemented and verified end to end: `meru_app` non-`BYPASSRLS` role,
`ENABLE`+`FORCE` RLS on all 51 tables, connection-level tenant binding,
`npm run rls:verify` passing 10/10 against Neon. See CLAUDE.md §5.1.

### 3.3 Screening

31,579 entries per database — OFAC SDN 19,199 · EU CFSP 6,234 · UK OFSI 5,135 ·
UN Consolidated 1,011. `GET /engines/screening/watchlist-status` reports the
per-list inventory and last ingest, and names any feed not re-confirmed in 14
days as stale.

Two parser traps worth remembering, both silent:

- EU marks people `<subjectType code="person" classificationCode="P"/>`.
  Matching `code="P"` matches nothing and files every designated person as an
  organization — they still screen, so nothing looks broken.
- UK publishes one row per **alias** keyed by `Group ID`. Left unfolded, one
  person is six rows and one true match looks like six hits. Its real header is
  on the second line, and gov.uk asset URLs carry an attachment id that changes
  every publication — use OFSI's blob storage.

**The defect that only real data exposed:** with `watchlist_entries` empty,
screening had never been exercised. Once 20k rows landed, *every invented name
screened as `escalated`* — a Double Metaphone match awarded a flat 0.85, exactly
the threshold. Phonetic agreement is now corroboration only, gated behind a
Levenshtein floor (not Jaro-Winkler, whose prefix bonus cannot separate
"Margarethe Vandersloot"/"MARGARITA 1" from "mohammed ali"/"muhammad ali").
0/12 invented names flag; 40/40 real designations still hit; p95 104ms.

> **The lesson generalises: a feature whose data source is empty has not been
> tested, only executed.** It was true of `watchlist_entries`, then of
> `ai_prompts` and `notification_templates`.

### 3.4 Communications

`GET /communications/threads` — the frontend's top ask for two cycles. COM was a
one-way delivery log with no key to group on, so two ImmiStack inboxes were
stubbed, one of which had shipped a fabricated mailbox. Threads are
`channel:counterparty`, case-folded, backfilled across history with the
identical derivation in SQL; replies and new messages go out through the same
dispatcher as everything else, so a send is *recorded* even with no transport
configured.

### 3.5 Integration provenance

Every adapter response now carries `provenance: { sandbox, adapterId, regulator,
requestId, latencyMs, retrievedAt }`. The flag existed on `AdapterResponse` all
along and the controller dropped it on success, so a sandbox visa status and a
live one were byte-identical over HTTP. **Every regulator connector is still
SANDBOX** — going live needs licensing, not code (§6).

### 3.6 Sessions

Revoking a session now invalidates its access token within 60 seconds (cached
check in `JwtStrategy`). Previously logout revoked the row and nothing read it,
so the token stayed good for up to an hour — which is why `POST /auth/logout-all`
was being recommended for a suspected compromise. Refresh-token rotation was
already correctly single-use via a conditional `revokedAt IS NULL` UPDATE.

---

## 4. Not built yet, in priority order

### 4.1 Core work, no external dependency

| Item | Rows unblocked | Note |
|---|---|---|
| **Wire Elasticsearch** | 4 | `src/search/elasticsearch/` is finished and imported by nobody; the facade is Postgres `ILIKE` |
| **Document generation** | 2 | cost agreements, invoice PDFs — `pdf-lib` |
| **Storage drivers** | 2 | Google Drive, Azure Blob; the provider interface is already right |
| **Trend analysis / time series** | 3 | BI is point-in-time only |
| **XLSX import** | 1 | `ImportService` takes CSV; XLSX needs `exceljs` |
| **CRM importers** | 3 | HubSpot / Zoho / Salesforce — three OAuth apps, one per importer |
| **Email analytics** | 3 | delivery/open/click events, A/B assignment |
| **Fraud pattern store** | 1 | cross-tenant duplicate hashing exists; no history to match against |
| **WebAuthn / passkeys** | 1 | server-side challenge store |
| **Consultation booking** | 1 | calendar events exist; no bookable-slot model |

Shipped since the last revision of this table: the import pipeline, SLA
escalation actions, TAT recording and analytics, generic comments, outbound
webhooks and retention enforcement.

### 4.2 Pack authoring — not engineering

This is where the immigration BRD actually lives, and it needs a domain author.

Done: immigration `entityTypes` (6), GRC `obligation`/`breach`, and the AU / CA
/ UK / NZ and AE / SA / QA / BH overlays with twelve country workflows.

Still to author, and it is domain work rather than engineering:

- **Per-subclass document checklists and eligibility rules.** The workflows
  exist; the `documentTypes` behind each subclass are still the vertical's
  generic five.
- **Country-specific `alertRules`** — visa expiry windows differ per
  jurisdiction, and the generic 90-day rule is a placeholder.
- **Health, tax, labour and education verticals**, if those are still on the
  roadmap. Each is one base pack.

### 4.3 Decisions needed from the business

| # | Decision | Recommendation |
|---|---|---|
| 1 | Realtime host for chat/presence/collaboration | **Ably** — no infra to run, works alongside serverless; five rows are not worth a second deployment target |
| 2 | Scheduler | **Upstash QStash** or cron-job.org — per-minute, retries, signed requests |
| 3 | Marketing module | **Do not build one.** Newsletters are `messaging.sequences[]`; SEO and social are not regulatory plumbing |
| 4 | AWS migration (BRD §18) | **Stay on Vercel + Neon**; revisit when a contract requires residency Neon cannot give |
| 5 | OCR | **Cloud Vision** — Tesseract on serverless is a bad fit for large scans |

---

## 5. Credentials — nothing works without these

**Free, already yours, just unset.** This is the cheapest work available
anywhere on the list and currently the largest single blocker.

| Variable | For | Consequence today |
|---|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, three price IDs | BILL | `/billing/checkout` → clean 503. **Test mode first** |
| `RESEND_API_KEY`, `MAIL_FROM` (verified domain) | COM | a provisioned tenant admin never receives their invite — **no customer can be onboarded** |
| `OPENAI_API_KEY` | AI, OCR, radar | every AI feature disabled |
| `CRON_SECRET` + an external scheduler URL | queue, ingestion | minute-level jobs run twice a day |

**Paid, no negotiation** (~$20–200/mo each): Ably/Pusher · Upstash QStash ·
Twilio *or* Meta WhatsApp Cloud API (**Meta Business verification is the long
pole — start early**) · Deepgram or Whisper · Elastic Cloud · DocuSign or
Dropbox Sign · AISStream/Spire for AIS · Google Cloud OAuth · Azure storage ·
HubSpot/Zoho/Salesforce developer apps.

**Commercial contracts, cannot be coded around:** Refinitiv WorldCheck One · Dow
Jones Risk & Compliance · Finacle (needs the bank client's own environment) · an
adverse-media/PEP feed · HS-code price benchmark data.

**Government access — licensing, not code:** AU VEVO/ImmiAccount (registered
migration agent or approved integrator) · IRCC · UK Home Office right-to-work ·
NZ INZ · CBUAE Open Finance certification · SAMA · QCB.

---

## 6. Regulator connectors — all eight are SANDBOX

| Adapter | Regulator | To go live |
|---|---|---|
| `au-home-affairs` | AU Department of Home Affairs | registered migration agent or approved integrator; VEVO is the gated part |
| `ae-cbuae` | UAE Central Bank | Open Finance certification |
| `sa-sama` | Saudi SAMA | licensing |
| `qa-qcb` | Qatar Central Bank | licensing |
| `bh-cbb` | Bahrain Central Bank | licensing |
| `ca-ircc` | Canada IRCC | licensing |
| `uk-home-office` | UK Home Office | right-to-work share-code access |
| `nz-inz` | NZ Immigration | VisaView access |

Each keeps its sandbox badge until real credentials are installed, and
`provenance.sandbox` is how the UI knows. **A UI that implies live regulator
data is the worst failure mode this product has.**

Going live for one regulator is `<ADAPTER>_SANDBOX=false` **plus** its
credentials. Either alone leaves the adapter in sandbox, deliberately: the
original rule was `NODE_ENV !== 'production' || <FLAG>`, which meant production
with no credentials declared itself **live**, aimed real requests at the
regulator, and — far worse — reported `provenance.sandbox: false` on the way
out. A missing credential can only ever mean "not licensed yet"
(`c05cadc`).

---

## 7. Things that will bite you

- **Unit tests do not assemble the module graph.** A service can be perfectly
  tested and the app still fail to boot on a missing module import — this repo
  shipped exactly that twice. Run `npm start` and read the route table.
- **The contract sweep passes on a well-formed 503.** It checks shape and
  posture, not whether an integration returned anything real. Both adapter
  defects found so far were caught by *reading a live response*, not by a green
  suite. After any deploy, call one regulator route and look at what came back.
- **`vercel env pull` blanks encrypted values.** A pulled `.env` is not evidence
  a variable is unset in production; check `vercel env ls`.
- **`verticalAttributes` MERGES on PATCH.** Send only what changed.
- **The four engines are cross-vertical**: `/engines/screening`, `/doc-intel`,
  `/vessel/risk`, `/radar/scan`. Distinct from
  `/integrations/{country}/screening`, which calls a *regulator's* service.
- **Config packs only upgrade on a greater `version`.** Edit a pack without
  bumping it and the loader silently keeps the old one.
- **The demo tenants are `status: "trial"`**, not `"active"`, and the trial
  lapses 2026-08-22. Any UI branching on `status === 'active'` renders the wrong
  state for both, and the lapse will look like a regression.
- **Three sessions push to `meru-core-fe`.** `git pull` before every commit.
- **`~/Documents/GitHub/immistack` is not this product.** It is a separate
  35-page prototype still carrying the duplicate `/platform` console that was
  deliberately deleted. Do not develop there; the live app is
  `meru-core-fe/immistack`.
- **Vercel deploys are CLI-only.** Pushing to GitHub does nothing.

---

## 8. Frontend contract notes

Rules the frontends hold to, which the API must keep making possible:

- Zero watchlist entries renders "lists not loaded", never "no hits".
- `riskScore: null` renders grey, never green.
- `live: false` is labelled stale on the record itself, not in a page corner.
- A missing position is listed as unplottable, never drawn at 0,0.
- No mock fallback survives in a page: `?? []`, never `?? someMock`.
- Config-pack data is rendered from the pack, never hardcoded — including
  navigation, which now comes from `GET /config-packs/me/navigation`.

Modules the frontend deliberately does **not** want to call directly: `Storage`
(`/documents` wraps it), `Elasticsearch` (`/search` is the right altitude),
`Queue` (`/jobs/status` covers the need).
