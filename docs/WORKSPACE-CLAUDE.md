<!--
  MIRROR — the canonical copy of this file lives at the workspace root,
  `~/dev/meru/CLAUDE.md`, which is NOT inside any git repository (the workspace
  has no root repo; it just contains four).

  It is mirrored here because a 60KB document that governs both repos and exists
  only on one laptop is one disk failure from gone, and because a new engineer
  clones a repo — they never receive the workspace root.

  Two copies means drift. If you change one, change the other in the same
  commit, or collapse them: `ln -sf` the workspace path at this file once the
  team agrees which location wins.

  Mirrored 2026-09-09.
-->

# CLAUDE.md — the Meru workspace

Durable architecture for everything under `~/dev/meru/`.
**The workspace moved out of `~/Documents` on 2026-09-07 — see §14. Do not move it back.**
Read this before touching either repo. It is the map and the shared rules; the
details live in the per-repo and per-app docs named in §1.

> **Last verified 2026-09-08 (Jonas, `curl /api-json`).** `/api-json` = **274 paths / 326
> operations** — up from 273/325 on 2026-09-05; `auth` dropped one path (`POST /auth/register`
> removed, per §16) and a new `alerts` prefix (2 paths) appeared, not yet traced to a
> controller. `GET /health/capabilities` = **2 live / 12 unconfigured**, `[UNVERIFIED: recount]`
> — that route now requires an operator token (§16, "role check is inert — FIXED 2026-09-07")
> and this pass had none, so this figure is carried forward from 2026-09-05, not re-checked.
> Any doc citing 248, 257, 262, 272 or 273 predates this pass.

---

## 1. What this folder is, and which doc wins

**This folder is a workspace, not a repository.** There is no root `package.json`,
no root lockfile and no git repo at the top. `git` commands run from here fail or,
worse, run against whichever nested repo you happen to be standing in.

It contains **two independent git repos**, plus **two more nested inside the
frontend repo**:

| Path | Repo | Remote |
|---|---|---|
| `meru-core/` | backend (NestJS) | `qognitionagency/meru-core` |
| `meru-core-fe/` | three product apps (Next.js) | `qognitionagency/meru-core-fe` |
| `meru-core-fe/immistack-marketing/` | ImmiStack marketing site (Vite) | `qognitionagency/immistack-` |
| `meru-core-fe/govx-marketing/` | GovX marketing site (Vite) | *(new)* |

> **The two marketing sites are separate repos physically nested inside
> `meru-core-fe`.** They must be listed in `meru-core-fe/.gitignore` or the parent
> repo tries to track them. Never `git add` from `meru-core-fe/` without checking
> what you are staging.

### The documentation set, and precedence

| File | Governs |
|---|---|
| `meru-core/CLAUDE.md` | backend architecture, rules, operations |
| `meru-core/AGENTS.md` | backend current state, gaps, credentials |
| `meru-core-fe/CLAUDE.md` | conventions shared by the three product apps |
| `meru-core-fe/AGENTS.md` | frontend operating notes and traps |
| `meru-core-fe/immistack/CLAUDE.md` | the immigration vertical UI — roles, matter lifecycle, money model, domain facts |
| `meru-core-fe/immistack/AGENTS.md` | ImmiStack backlog, where-a-change-goes, standing context |
| `meru-core-fe/immistack/BUSINESS.md` | ImmiStack commercial strategy and the Australian legal constraints |
| `meru-core-fe/governancex/CLAUDE.md` | the banking-GRC vertical UI |
| `meru-core-fe/meru-dashboard/CLAUDE.md` | the operator "God UI" |
| `meru-core-fe/immistack-marketing/CLAUDE.md` | the ImmiStack marketing site |
| `meru-core-fe/govx-marketing/CLAUDE.md` | the GovX marketing site |
| **this file** | everything that spans repos and belongs to none of them |

**When two sources disagree, this is the order:**

```
/api-json  (generated from backend code — cannot drift)
   ↓
the nearest CLAUDE.md  (an app doc may narrow a rule, never contradict the core)
   ↓
the repo CLAUDE.md
   ↓
this file
   ↓
AGENTS.md
   ↓
any PDF, deck, BRD or strategy memo  ← lowest. Verify before repeating.
```

Guessing field names has produced real bugs. Screening hits use `matchName`, not
`name`. `/jobs/status` returns `{jobs:[…]}` keyed on `job`. Vessel position is
nested under `position`, not flat `lat`/`lng`. **Work from the spec.**

---

## 2. What Meru is

A **Regulatory Operating System**. One horizontal engine owns roughly 80% of
regulatory plumbing — tenancy, identity, records, documents, payments, workflow,
audit, screening — and the remaining 20% of vertical- and country-specific
behaviour is injected as **JSON config packs**.

**Adding a vertical is a pack plus a UI. It is never a new backend.**

| Layer | What it is | Cost per new vertical |
|---|---|---|
| Meru Core | 14 horizontal modules + specialist engines | one-time, built |
| Config packs | JSON: entity types, workflows, nav, dashboards, rules, fees | **weeks** |
| Vertical UIs | ImmiStack, GovernanceX, Meru Dashboard | 2–6 weeks each |

The moat is the **Common Corridor** — UAE, KSA, UK, Canada, Australia. Wire a
regulator in once and every vertical inherits it.

### North-star metrics

New vertical ≤ **6 weeks** · new country ≤ **3 weeks** · shared feature code ≥
**80%** · AI citation coverage **100%** · regulatory-radar lag ≤ **24 h** ·
**tenant data-isolation incidents: 0, ever.**

---

## 3. How Meru stacks

Each layer may only know about the one below it.

```
   L4   VERTICAL PACKS (JSON)      immigration.json · grc.json
         ↑                          the vocabulary: entity types, workflows,
         │                          navigation, documents, fees, dashboards
   L3   COUNTRY OVERLAYS (JSON)    au · ca · uk · nz   |   ae · sa · qa · bh
         ↑                          only what is LOCAL: regulators, locales,
         │                          thresholds, country workflows
   L2   SPECIALIST ENGINES         screening · doc-intel · regulatory radar ·
         ↑                          vessel tracking
   L1   14 CORE MODULES (~80%)     IAM TCM CRM SRCH AI WF FORM TASK
                                    COM DOC BILL BI AUD INT
                                    Knows "a record that can be worked".
                                    Nothing else.
```

Core is the engine. Verticals sit on top of it; country modules on top of the
verticals. **A vertical never reaches sideways into another vertical, and core
never reaches upward into either.**

---

## 4. The product surface

Five deployables, one API. Three product apps live in `meru-core-fe`; the two
marketing sites are nested repos.

| App | Path | Kind | Port | Domain |
|---|---|---|---|---|
| **meru-core** | `meru-core/` | NestJS API | 8000 | `meru-core.vercel.app` |
| **meru-dashboard** | `meru-core-fe/meru-dashboard/` | operator God UI, dark-only | 3000 | `meru-dashboard.vercel.app` (`app.meru.com` planned, not resolving) |
| **immistack** | `meru-core-fe/immistack/` | immigration product | 3002 | `app.immistack.com` (Vercel project `immistack-app`) |
| **governancex** | `meru-core-fe/governancex/` | banking-GRC product, `/en` `/ar` | 3001 | `govx-app.vercel.app` |
| **immistack-marketing** | `meru-core-fe/immistack-marketing/` | Vite SSG marketing | — | `www.immistack.com` (Vercel project `immistack-marketing`) |
| **govx-marketing** | `meru-core-fe/govx-marketing/` | Vite SSG marketing | — | `govx.vercel.app` |

**One domain table, verified 2026-09-05** — every other domain table in this workspace must
match this one:

| Host | Serves | Vercel project |
|---|---|---|
| `meru-core.vercel.app` | backend API | `meru-core` |
| `meru-dashboard.vercel.app` | operator God UI | `meru-dashboard` |
| `app.immistack.com` | ImmiStack product | `immistack-app` |
| `www.immistack.com` (apex 301→www) | ImmiStack marketing | `immistack-marketing` |
| `govx-app.vercel.app` | GovernanceX product | `governancex` |
| `govx.vercel.app` | GovX marketing | `govx-marketing` |

**`app.meru.com` does not resolve (NXDOMAIN) — the dashboard has no public hostname today.**
**`api.meru.com` does not exist anywhere** — do not write it into a doc; the backend is
`meru-core.vercel.app` only. `meru-core-fe.vercel.app` is `DEPLOYMENT_NOT_FOUND`.

> **Marketing and product are never the same app.** The product is behind auth
> and locale-routed; the marketing site is public, static, and must build and
> deploy even when the API is down. Merging them costs both SEO and build
> simplicity — and it is why `immistack.com` has been carrying product claims it
> cannot back.

**Domain cutover: done.** `www.immistack.com` serves the marketing build (Vercel
project `immistack-marketing`) and `app.immistack.com` serves the product
(project `immistack-app`), both verified live 2026-09-05. `--prod` from
`immistack-marketing/` updates the live public site; confirm the gates first.

> **Why `govx-app.vercel.app` and not `app.govx.vercel.app`.** Vercel grants a
> project exactly `<project>.vercel.app`; nested subdomains of that domain are
> not assignable. An earlier plan named `app.govx.vercel.app` — it cannot exist.
> A real `app.govx.com` needs the domain to be owned first. Likewise confirm
> `meru.com` is actually owned before anything depends on `app.meru.com`.

---

## 5. How verticals work

| Vertical | Base pack | Country overlays | UI app | Vertical DB |
|---|---|---|---|---|
| **Immigration** | `verticals/immigration.json` **2.3.0** | `au` **2.4.0** · `ca` 2.2.0 · `uk` 2.2.0 (**country `GB`**) · `nz` 2.2.0 | `immistack/` | `IMMISTACK_DB_URL` |
| **Banking GRC** | `verticals/grc.json` **2.1.0** | `ae` · `sa` · `qa` · `bh` — all **2.1.0** | `governancex/` | `GOVX_DB_URL` |
| `labour` | **none** | — | — | control plane |
| *(operator)* | n/a | n/a | `meru-dashboard/` | control plane |

Versions read directly from the JSON on disk, 2026-09-05. AU is ahead of the base because
`config-pack-loader.service.ts` now rejects a resolved pack whose fee/stage `atStep` names no
real workflow step (§6), and AU 2.4.0 is the fix for that (`countries/au-immigration.json`).

`labour` is a legal tenant vertical with **no pack**. `VerticalPackService.forVertical('labour')`
returns `null` and every Layer-4 feature is silently absent. Do not create a
`labour` tenant expecting a working product.

### Adding a vertical

1. Add the code to `VerticalType` in `meru-core/src/iam/entities/tenant.entity.ts`
   — this is the enum `tenants.vertical` is typed with.
2. Extend the Postgres `vertical_type_enum` in a **new** migration.
3. Author `packages/config-packs/verticals/<code>.json`.
4. `npm run packs:schema`, bump the pack `version`, run the loader spec.
5. Build the UI as its own Next.js app in `meru-core-fe`, with its own lockfile
   and its own Vercel project whose Root Directory is the app folder.

> ### The trap that has already fired: four vertical enums exist and they disagree
>
> | Source | Values |
> |---|---|
> | Postgres `vertical_type_enum` | `immigration, grc, labour` |
> | `src/iam/entities/tenant.entity.ts` → `VerticalType` | `immigration, grc, labour` ✅ the real one |
> | `src/iam/enums/vertical.enum.ts` → `VerticalType` | + `fintech, legal` (policy lookup only) |
> | `packages/config-packs/_schema/pack.schema.ts` | **nine** values |
> | `src/common/types.ts` → `MeruVertical` | six — includes `banking`, **excludes `grc`**, documented nowhere |
>
> A pack declaring `health`, `tax`, `education` or `banking` **loads cleanly and
> resolves for no tenant, ever.** This is how GovernanceX once resolved to *no
> pack at all* — and nothing logged, because "this vertical has no pack" is
> legitimate during onboarding. `CreateTenantDto` deliberately validates against
> the **entity** enum so a bad vertical is a 400, not a 500 at insert.

---

## 6. How country packs work

A country overlay names its base with `extends` and states **only what is local**.
`countries/ae-grc.json` is 31 lines: locales, one regulator, and a screening list
override. The loader resolves the chain and stores the merged result;
`extends` is deleted before storage.

### The pack contract

**31 top-level keys.** Required: `code`, `name`, `version`, `vertical`, `locales`.
Optional: `description`, `country`, `extends`, `regulators`, `roles`,
`documentTypes`, `documentTemplates`, `workflows`, `screening`, `compliance`,
`kpis`, `prompts`, `messaging`, `rules`, `alertRules`, `fees`, `paymentPlans`,
`scoringModels`, `relationships`, `navigation`, `dashboards`, `importMappings`,
`entityTypes`, `defaults`, `uiConfig`, `metadata`.

**Zod strips anything else, silently.**

### The merge algorithm — `config-pack-loader.service.ts`

- Objects merge key by key; **arrays merge by identity**.
- `identityOf` checks **`['key', 'type', 'id', 'code']` in that order**. A
  `workflows[].steps[]` element has both `type` and `id`, so steps merge by
  **`type`** — not `id`. Overriding an existing workflow id from an overlay would
  collapse its steps by type.
- **If *any* overlay element lacks an identity, the whole base array is replaced.**
  That is how `locales` and `screening.lists` replace rather than merge.
- **Merge runs before Zod validation**, so an overlay may state a partial
  `screening` block and inherit the rest.
- `null` overwrites; `undefined` is skipped.

### Five rules for changing a pack

1. **A schema change is a three-part commit.** Extend the Zod schema, regenerate
   the JSON Schema with `npm run packs:schema`, **and** add the key to the
   loader's 23-key list in `upsertPack`. Miss the third and the array validates,
   persists nowhere, and is read by nobody. `config-pack-loader.service.spec.ts`
   is the guard — it regex-matches the loader's own source.
2. **Every array is optional and additive.** A pack omitting one must still load.
3. **No `eval`.** Conditions are JsonLogic through `RuleEvaluatorService`, which
   uses an operator whitelist and **refuses to evaluate a numeric comparison
   against a variable the record does not carry** — because `null < 90` is `true`
   in JavaScript, and that once fired "expires within 90 days" on every record
   with no expiry date.
4. **Bump the `version`.** Packs only upgrade on a strictly greater version;
   otherwise the loader reports `up-to-date` and writes nothing.
5. **`metadata` is a strict object.** The overlays' `alertRulesReview` and
   `workflowConditions` prose is silently discarded before storage.

> **The vertical bases are not country-neutral.** `grc.json` carries
> `compliance.dataResidency: "AE"`, CBUAE frameworks, a `help.governancex.com/uae`
> URL and a base step with `apiAction.adapterId: "uae-central-bank"`.
> `immigration.json` carries `dataResidency: "AU"` and a
> `482-tss-employer-sponsored` workflow. **A new country overlay inherits UAE or
> AU defaults it must explicitly override.**

---

## 7. The rules that actually bite

### 7.1 The 80/20 rule

**If you are about to write vertical-specific vocabulary into `meru-core/src/` —
stop.** Visa subclasses, document checklists, fee schedules, stage names,
counterparties and breaches belong in a config pack. Core knows "a record that
can be worked"; it does not know what a visa is.

This is the rule that keeps one platform from becoming two bespoke products.

### 7.2 The stacking rule — ImmiStack work must not break GovX

**A change made for one vertical must not break another.** GovernanceX work that
damages ImmiStack has broken the product, not a portal. If verticals can break
each other, there is no horizontal core — only two bespoke products sharing a
database.

**In `meru-core-fe` this is nearly free.** Three apps, three lockfiles, three API
clients: `governancex/` cannot import from `immistack/`.

**In `meru-core` it is not free.** Three things leak across verticals:

1. Shared code in `src/`.
2. **Entitlement grants**, which are *data* — see below.
3. The single 19-value `EntityType` enum in
   `src/crm/entities/universal-entity.entity.ts`, which both verticals draw from.

So before changing anything in `src/`:

1. **Ask whether it belongs in a pack instead.** Usually it does.
2. **If it must be core, make it additive.** Extend; do not replace. Existing
   values keep resolving.
3. **Verify against a tenant of the vertical you were *not* working on.**
4. **Re-run the frontend sweep against both baselines** — immistack **33/33**,
   governancex **27/28**. If immistack drops, stop and revert.

> #### The worked example: the entitlement vocabulary
>
> Every tenant carries six `CORE_MODULES` — `crm, cases, tasks, documents,
> payments, communications` — and plan tiers add `forms, ai_automation,
> advanced_analytics, marketing, branding, api_access, sso`. ImmiStack tenants are
> live on those, and **entitlements are frozen into `tenants.settings.modules` at
> provisioning** — deliberately, so a tenant's grant does not move when a plan
> definition changes.
>
> A migration that rewrites those codes rewrites **live immigration grants**, and
> it does so *silently*, because the grant is data, not code: nothing fails to
> compile, no test goes red, and the first symptom is a customer losing a module
> in production.
>
> Done safely: new codes **additive** with the old ones still resolving; the new
> guard applied to **GRC routes only**, never retrofitted onto a route ImmiStack
> already calls; the migration reversible and verified against an immigration
> tenant first; the sweep re-run after **every** change.

### 7.3 Never render unknown data as a positive result

This is a regulatory product. An applicant stops chasing a document, a compliance
officer clears a counterparty, a firm lodges an application — on what this UI
says. **Every serious defect found in either repo has been the same shape:
missing data presented as a clean result.**

| Signal | Render as | Never |
|---|---|---|
| `watchlist-status.entries === 0` | "lists not loaded", block the run | "no hits" |
| `riskScore: null` | grey / no data | green / cleared |
| checklist `uploaded: null` | "not asked" | "missing" |
| checklist `applies: null` | "may apply" | a firm requirement |
| `provenance.sandbox: true` | "SANDBOX — not live regulator data" | a live regulator result |
| widget `value: null` + `unavailableReason` | grey, show the reason | `0`, or a red miss |
| widget `truncated: true` | "5,000+" — a lower bound | the exact number |
| agent run `status: "failed"` at HTTP 200 | failed | success |
| `citationEnforced: false` | unsourced | a normal answer |

The mirror image matters too: **noise must never present as a finding.** A
`warning` is a prompt for a human; only an `alert` is a designation. An invented
name once returned `riskLevel: critical` and "file a SAR" off a single 0.86 match
against a *vessel*.

If you cannot tell whether something is safe to render, it is not.

### 7.4 Say what a record is not

`POST /crm/entities/:id/acceptance` returns **`isSignature: false`** and says so
in the payload. It is an audited record of assent — subject, user, email,
timestamp, IP, user-agent, SHA-256 of the exact bytes shown — with no signatory
certificate, no tamper-evident envelope and no timestamp authority. **It is not
an electronically signed instrument, and a UI must say so where it collects it.**
There is no e-signature primitive in Meru, deliberately. Do not build an
approximation: everyone downstream treats an approximation as the real thing.

Likewise `NotificationType.WHATSAPP` exists so a conversation can be *recorded*,
with no transport behind it, and `GET /crm/entities/export` sets
`X-Export-Truncated`.

### 7.5 One generic record resource

There is no `/cases` and no `/leads`, by design. Everything is
`/crm/entities?type=…`. Vertical fields go in `verticalAttributes`; `status`,
`dueDate` and `assignedTo` are promoted indexed columns.

**`verticalAttributes` deep-merges on PATCH** — send only what changed. Arrays
replace; `null` deletes the key; `POST /crm/entities` is the one genuine replace
path. `PATCH` refuses `type`; conversion is `POST /crm/entities/:id/convert`.

`obligations` and `breaches` (GovX) and `cases` (ImmiStack) are structurally
identical — a record with `status` + `dueDate` + `assignee` + `stage`. Three
bespoke tables would be exactly the vertical leakage this model exists to prevent.

### 7.6 Render from the pack, not from your code

Navigation comes from `GET /config-packs/me/navigation?portal=…`, pre-filtered by
portal, role **and** entitlement. Entity fields, checklists, fee schedules, KPIs,
dashboards and email templates all come from the pack. **Hardcoding any of them
means a pack update silently stops reaching users** — which defeats the whole
architecture.

Hiding a nav item is **cosmetic**, not access control. Every route behind it must
enforce its own.

### 7.7 Audit everything

`audit_logs` is append-only via database triggers — not RLS, which a `BYPASSRLS`
owner would evade — and hash-chained. Cross-tenant access goes through
`TenancyService.runAsGod`, which writes a `CRITICAL` entry **before** the work and
**rethrows if the audit write fails**: if the access cannot be recorded, it does
not happen.

### 7.8 The ledger has two directions

`payments.direction` is `inbound` | `outbound` in one table, and the two are
**never summed together**. `GET /payments/summary` reports `receivableMinor` and
`payableMinor` separately. A `client`-role caller sees `inbound` only.

---

## 8. Tenancy and isolation

- Every tenant-scoped table has a **`"tenantId"`** column, camelCase and quoted.
- The app connects as **`meru_app`**, a role with **no `BYPASSRLS`**.
  `DATABASE_URL` (owner) is for migrations only; `DATABASE_APP_URL` is runtime.
- **51 tables** carry `ENABLE` *and* `FORCE` row-level security. Policies fail
  closed.
- `TenantAlsMiddleware` → `TenantBindingInterceptor` → `applyRlsToDataSource` sets
  `app.current_tenant_id` on the *same pooled connection*, and releases the
  connection and throws if it cannot.
- Boot refuses to start under `NODE_ENV=production` if the runtime role holds
  `BYPASSRLS` — RLS is inert for an owner role.
- Bootstrap identity lookups use `TenantContext.runAsSystem`.

> **RLS isolates tenants, not users inside a tenant.** Every resource a
> `client`-role token can reach needs its own user-scoping check **in the service,
> not the controller**. This has been missed four times — `/crm/entities`,
> `/payments`, `/communications/threads` (fixed; see below), and **`/tasks`**,
> found by Anton 2026-09-05: `task.service.ts` filters only on `tenantId`, no
> `@Roles` anywhere on `task.controller.ts`, so a `client`-role JWT reads every
> task in the tenant. Fix tracked as Luke E-8, per ADR 0007.
>
> **Correction to earlier prose (ADR 0005, 2026-09-05):** the workspace and
> ImmiStack docs previously stated user-scoped communications threads were an
> open gap. **They are not** — `ThreadService`/`CommunicationsController` already
> scope a `client`-role caller to their own thread. The remaining work is
> frontend wiring (client-portal messages) and an audit entry on send, not a
> backend authz fix. Do not re-open this as a backend defect.

**Never trust "RLS is on" without running `npm run rls:verify`.**

> **When `rls:verify` cannot run, `scripts/smoke/cross-tenant.sh` is the real
> gate, not a fallback.** It proves the property over HTTP with two live
> tenants and needs no database credential — verified **10/10 against
> production 2026-09-08**. `rls:verify` needs `DATABASE_APP_URL`, which
> `vercel env pull` returns blank; the *role* is fine (`meru_app`,
> `rolbypassrls=false`, and `DATABASE_APP_URL` is set on Vercel Production), it
> is only the local `.env` that is empty. **Do not run
> `scripts/provision-rls-role.js` to obtain it** — that `ALTER`s the role's
> password and takes production down until Vercel's variable is rotated to
> match.

### The three-database split is scaffolding, not shipped

`src/core/tenancy/vertical-datasources.service.ts` routes `grc` to `GOVX_DB_URL`
and `immigration` to `IMMISTACK_DB_URL`, falling back to the control plane when
unset. It is provided and exported by `TenancyModule` and **injected by nobody** —
`forVertical()` has zero callers. All vertical data currently lands in the
control-plane database, protected by RLS alone. Treat the split as designed, not
active.

---

## 9. Deployment

Vercel, CLI-driven. **Pushing to GitHub does not deploy anything.**

> ### Git integration IS active on some projects — verified 2026-09-07
>
> The line above ("pushing to GitHub does not deploy") was **wrong, and acting on
> it broke production.** Three `git push origin main` on `meru-core` each shipped
> a Production deployment; the alias
> `meru-core-git-main-qognitionagencys-projects.vercel.app` is the tell. Because
> the migration was expected to be run by hand *after* a deliberate CLI deploy, the
> code went live querying a `subjectEmail` column that did not exist yet, and every
> read of `universal_entities` answered 42703 until the migration was applied.
>
> | Repo | Push to `main` | Effect |
> |---|---|---|
> | `meru-core` | **deploys to Production** | migrations must be applied *first*, or in the same minute |
> | `immistack-` (marketing) | **builds Production** for the `immistack` **and** `immistack-marketing` projects | a failing gate leaves the previous build serving, which is what saved `www.immistack.com` here |
> | `meru-core-fe` | no deployment | the three product apps deploy by CLI only |
>
> **So the rule is per-project, and the safe order for `meru-core` is: apply
> migrations, then push.** `npm run migration:run` needs `DATABASE_URL` (the owner
> role) from `meru-core/.env`; `vercel env pull` returns it blank. Confirm what a
> push will do with `vercel ls <project>` before pushing, not after.


```bash
# from inside the app directory
vercel deploy --prod --yes --scope qognitionagencys-projects
```

- `--scope` is **mandatory**; without it non-interactive mode fails `missing_scope`.
- There is no root `package.json` in `meru-core-fe`, so a repo-root build fails.
  **Each Vercel project's Root Directory must be the app folder.**
- Each product app keeps its **own** `pnpm-lock.yaml` — deliberately not a pnpm
  workspace, because a workspace lockfile would sit outside the Root Directory.
- pnpm 10 blocks dependency build scripts; each app declares
  `pnpm.onlyBuiltDependencies` for `sharp`, `@swc/core`, `@parcel/watcher`,
  `unrs-resolver`. A new dependency with a postinstall script must be added there.
- Build failures surface only in the build log:
  `vercel inspect --logs <url> --scope qognitionagencys-projects`.
- **`--prod` on `immistack-marketing` updates the live public site. Confirm first.**

> **Two Vercel facts that cost an evening on 2026-09-06, both verified:**
>
> - **`immistack-app` has no Git repository connected.** Vercel therefore refuses
>   preview environment variables for it — branch-scoped and "all preview branches"
>   both error with *"does not have a connected Git repository"*. Preview config can
>   only come from `--build-env` at deploy time, and the dashboard cannot show which
>   commit is deployed.
> - **`meru-core` previews have ZERO environment variables** (against 23 on
>   Production), so every preview returns `FUNCTION_INVOCATION_FAILED` on every route
>   by construction — no `DATABASE_URL`, no `JWT_SECRET`. A backend preview is a
>   **build** gate only, never a runtime one. Do not read a preview 500 as a regression.
> - A preview URL is regenerated every deploy, so it can never be CORS-allowlisted.
>   `immistack-staging.vercel.app` is a stable alias pinned to the latest preview and
>   is in the allowlist — before it existed, `app.immistack.com` was the only accepted
>   browser origin, which made "test against real data" and "ship to customers" the
>   same action.

Backend gates, before every deploy:

```bash
npm run build       # must be clean
npm run check:cjs   # one ESM-only package in the require graph =
                    # FUNCTION_INVOCATION_FAILED on EVERY route
npm test
npm run rls:verify  # needs DATABASE_APP_URL
BASE_URL=https://meru-core.vercel.app npm run smoke:sweep
```

> **"308 routes mapped" is not "it booted".** The route table is built before
> providers are instantiated, so a DI fault prints a full route table and *then*
> dies. Grep for **`Nest application successfully started`**.
>
> **The contract sweep passes on a well-formed 503.** It cannot see a wrong
> answer, only a malformed one. 788 checks once passed against a build where a
> client could read other clients' mail, notification dispatch had been dead for
> 34 hours, and screening recommended a SAR on a vessel-name collision.
>
> **A merged commit is not a shipped one.** Check `/api-json`'s path count.

---

## 10. The serverless constraint — stated once

`meru-core/vercel.json` rewrites **every** path to a single `api/index.js`
function: 1024 MB, `maxDuration: 60`, region `sin1`. Everything below follows
from that one fact, and none of it is negotiable while the backend hosts this way:

- **No held-open connections.** WebSockets, presence, live collaboration and team
  chat are architecturally impossible. Poll `GET /communications/threads` instead.
- **BullMQ workers and `@nestjs/schedule` are gated off.** Every job is also an
  HTTP route under `/jobs`, behind `CronSecretGuard`, which fails closed when
  `CRON_SECRET` is unset.
- **There are exactly two Vercel crons** — `/jobs/tick?scope=daily` at `0 2 * * *`
  and `/jobs/tick?scope=fast` at `0 3 * * *`. The "fast" tick is scheduled
  **daily**. Minute-level work needs an external scheduler (Upstash QStash,
  cron-job.org) pointed at `/api/v1/jobs/tick?scope=fast`.
- **`CRON_SECRET` IS set on Vercel Production** (verified `vercel env ls`,
  2026-08-22), so the daily Vercel cron is authorised. Whether the 15 jobs in
  `JOB_CADENCE_MINUTES` (`jobs.controller.ts:63-97`) have actually *succeeded*
  is a separate question: check `GET /jobs/status` with an operator token, and
  `watchlist-status.entries` before trusting a screening result — see §16.
- **Read-only filesystem** outside `/tmp` — hence `memoryStorage()` for uploads.
- **Static assets must be declared** in `functions.includeFiles`; that is why
  `packages/config-packs/**` is listed there.
- **DB pool `max: 1`** per invocation.

`api/index.js` deliberately loads the already-compiled `dist/` output, because
Vercel bundles `api/` with esbuild and esbuild does not support
`emitDecoratorMetadata` — compiling the NestJS source there would strip the
metadata DI depends on. It also **mirrors `src/main.ts`'s middleware stack by
hand**; `ResponseEnvelopeInterceptor` is load-bearing, and dropping it there
silently breaks all three frontends.

---

## 11. API conventions

Base `https://meru-core.vercel.app/api/v1` · Swagger `/api` · spec `/api-json` ·
health `/api/v1/health`.

**Envelope**, on success *and* error — there is no `success` field:

```jsonc
{ "data": T | null,
  "meta": { "requestId", "timestamp", "version": "v1", "pagination?", "vertical?" },
  "error": { "code", "message", "details?", "helpUrl" } | null }
```

- Each app's axios interceptor unwraps it and **throws on a non-null `error` even
  at HTTP 200** — `/integrations/ae/regulatory-updates` does exactly that when
  upstream is down. Without the throw you get a silent empty page.
- `unwrapLegacySuccess()` peels a double `{success, data}` envelope from ~10
  legacy controllers. Do not delete it until the backend confirms it dropped that
  shape — and then delete it in **all three** apps.
- Pagination lives in `meta.pagination`. Use `apiGetWithMeta` or lists show page 1
  with no total.
- Error codes are `MER-<FAMILY>-NNNN`: `AUTH`, `TENANT`, `VAL`, `RES`, `RATE`,
  `SRV`, `EXT`. Every error carries a `helpUrl`.

---

## 12. Credentials — the largest blocker, and mostly free

`meru-core/AGENTS.md` §5 is authoritative. Golden rule per the 2026-09-05 operator
decision: **Vercel · Neon Postgres · Neon Auth (post-pilot) · DeepSeek · Upstash Redis.**

> **Correction (Jonas, 2026-09-08): `RESEND_API_KEY` and `RESEND_FROM` are SET on `meru-core`
> Production**, confirmed via `vercel env ls` this session. Every doc in this workspace calling
> Resend "the largest blocker" or saying "no customer can be onboarded" predates this and is
> now wrong — invites can be sent. This section's title and the table below have been updated;
> the `vercel env ls` snapshot elsewhere in this doc set (23 vars, 2026-09-05) is one pass
> behind and should be re-read as "at least 23, Resend now confirmed among them."

The ones that stop the product today, re-verified against `vercel env ls` 2026-09-08:

| Unset | Consequence |
|---|---|
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (operator's chosen storage driver — see below) | `POST /documents/upload` returns a clean **503** naming the missing vars. Only `AWS_REGION` is set — no AWS secret, no Supabase var at all |
| `STRIPE_SECRET_KEY` + price IDs | `/billing/checkout` returns a clean 503 |
| `OPENAI_API_KEY` | every AI surface answers "not connected" — `ai.service.ts:131-138` is the read; see the note below on which AI var actually matters |

**Set, and no longer blockers:** `RESEND_API_KEY` + `RESEND_FROM` (invites send).
`CRON_SECRET` is set; the daily Vercel cron is authorised.

> **`DEEPSEEK_API_KEY`, `AI_BASE_URL`, `AI_API_KEY`, `AI_DEFAULT_MODEL` and every
> `UPSTASH_*` var are read by NOTHING in `meru-core/src` today** — verified by grepping each
> name individually this session (a combined `grep -E` on these terms false-matches, because
> `AI_API_KEY` is a literal substring of `OPENAI_API_KEY` — grep each one separately or you will
> see spurious hits and wrongly conclude it is read). `grep -rn "DEEPSEEK_API_KEY" src`,
> `grep -rn "AI_BASE_URL" src`, `grep -rnE "\bAI_API_KEY\b" src`, `grep -rn "AI_DEFAULT_MODEL"
> src` and `grep -rn "UPSTASH" src` each return **zero matches, full stop** — not even in a
> comment. Setting any of them on Vercel today has **zero effect**. `ai.service.ts:131` reads
> `OPENAI_API_KEY` and nothing else; the queue and rate-limit code
> (`src/config/configuration.ts:137-138`) reads `REDIS_HOST`, not an Upstash var. ADR 0003
> (DeepSeek provider abstraction) and ADR 0004 (Upstash Redis + QStash) are both still
> **Proposed — not merged**; they describe an intended future read path, not a current
> one. Do not set these expecting them to do anything until one of those ADRs ships — that is
> the wild-goose-chase this note exists to prevent.
> An external scheduler for `scope=fast` is still needed regardless of Upstash: minute-level
> jobs (queue drain, notification dispatch, SLA watchdog, alert rules) run daily at best without
> one, pointed at `/api/v1/jobs/tick?scope=fast`.

**Storage — one story, not two.** `StorageDriverRegistry` (`meru-core/src/storage/`) holds
two real drivers, S3 and Supabase, each registering only when its own credentials are
present. The operator has chosen **Supabase Storage** (fewer required vars: `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY`, bucket optional and defaulted to `meru-documents`). Neither
driver is configured on Production today — only `AWS_REGION` is set, no AWS secret, no
Supabase var at all — so every environment answers a clean **503 naming the missing
variables**, not a silent failure. `documents.service.ts` does not construct its own S3
client; every byte goes through `StorageService` → the registry. See `meru-core/CLAUDE.md`
§5.1b.

> **The code reads `RESEND_FROM`. Older docs say `MAIL_FROM`. Set the one the
> code reads** — `MAIL_FROM` does nothing and is read by nothing.

`vercel env pull` returns encrypted values **blank**; a pulled `.env` is not
evidence a variable is unset. Check `vercel env ls`.

---

## 13. Everything regulator-facing is SANDBOX

All eight adapters — `au-home-affairs`, `ca-ircc`, `uk-home-office`,
`nz-immigration`, `uae-central-bank`, `sa-sama`, `qa-central-bank`,
`bh-central-bank` — are sandbox. **Going live is licensing, not code.**

Each adapter computes `useSandbox = !(liveRequested && credentialsPresent)`, so
it is sandbox unless there is **both** a deliberate `<ADAPTER>_SANDBOX=false`
**and** real credentials. Either alone leaves it sandboxed, deliberately: a
missing credential can only ever mean "not licensed yet". The original guard was
`NODE_ENV !== 'production' || FLAG`, which meant production with no credentials
declared itself *live*, aimed real requests at the regulator, and reported
`provenance.sandbox: false` on the way out.

Every regulator response carries `provenance` — `{sandbox, adapterId, regulator,
requestId, latencyMs, retrievedAt}` — and a failed adapter call is **503 when
retryable, 502 otherwise**, never a 200 with `data: null`.

There is also less government API surface than most planning documents assume:

- **No government publishes a document-checklist API.** Home Affairs offers a
  human web tool only. The per-subclass checklist comes from the config pack via
  `documentTypes[].appliesWhen`, and that is the correct and only answer.
- **No lodgement API.** ImmiAccount is a human portal; agents lodge by hand.
- **VEVO** is reachable through a commercial gateway, with recorded consent.

---

## 14. Local environment

```
NEXT_PUBLIC_MERU_API_URL=https://meru-core.vercel.app/api/v1
NEXT_PUBLIC_MOCK_MODE=false
NEXT_PUBLIC_ALLOW_MOCKS=true    # local only — UNSET on Vercel Production
```

> **With no `.env.local`, `MERU_API_URL` falls back to localhost and `MOCK_MODE`
> turns on** — the app runs entirely on mocks and none of the live wiring
> executes. This is the single most common way a session is wasted here.

Other things that cost an afternoon:

- **`tsc` hanging at 0% CPU** is a stale `tsconfig.tsbuildinfo`. Delete it and
  pass `--incremental false`. A full typecheck is 1–7 minutes; batch changes.
- **`node_modules` is frequently corrupt** — a whole day of `ETIMEDOUT (errno -60)`
  failures was a partial install, not iCloud. `rm -rf node_modules && pnpm install
  --frozen-lockfile` before debugging a type error.
- **Demo tenants are `status: "trial"`, not `"active"`.** UI branching on
  `status === 'active'` renders the wrong state.
- **These sibling folders are not this product:**
  `~/Documents/GitHub/immistack` (a standalone Next.js prototype),
  `~/Documents/GitHub/immistack-` (the marketing site's own clone), and
  `~/Documents/GitHub/opal` (`opal-consulting`, a client marketing site).
  Do not develop in them.
- **`~/Documents/immistack/` is a superseded ZIP snapshot — do not read or scope from it.**
  `backend/meru-core-main/` and `meru-core-fe-main/` are GitHub "Download ZIP" extractions
  (no `.git`, sitting beside their own `.zip` files, uniform `rwxr-xr-x` permissions, one
  frozen mtime, **341 `.ts` files against this tree's 379**), and they are **missing**
  `document-access.service.ts`, `pack-workflow*` and `iam/entitlements/` — i.e. they predate
  the 2026-08-22 fixes in §16. Its `CLAUDE.md` / `AGENTS.md` / `BUSINESS.md` were the
  ancestors of the ImmiStack app docs and were **installed, corrected, at
  `meru-core-fe/immistack/` on 2026-08-26.** *(Verified 2026-08-26.)*
- **The tree must live outside `~/Documents`. This was the root cause of every
  "slow toolchain" incident in this workspace, and it was misdiagnosed three
  times before being settled.** *(Root-caused 2026-09-07; workspace relocated to
  `~/dev/meru` and every gate went green immediately.)*

  `~/Documents` is synced by iCloud Drive's **Desktop & Documents Folders**. With
  iCloud storage **full**, `bird`
  (`iCloudDriveCore.framework/Versions/A/Support/bird`) retries uploads forever
  and serialises every filesystem operation on the sync root behind itself.
  Measured during the incident: `bird` holding **923 minutes of accumulated CPU
  at 23–51%**, while `mv`, `ditto`, `tsc`, `jest`, `git` and `vercel` each sat at
  **0.0% CPU** making no progress.

  **The three commands normally used to detect iCloud involvement all return
  nothing here, which is exactly why it kept being ruled out:**

  | Check | Returns | Why it misleads |
  |---|---|---|
  | `mdls -name kMDItemIsCloudManaged <file>` | `(null)` | only set on *evicted* files |
  | `find . -name '*.icloud'` | no matches | placeholders only appear after eviction |
  | `brctl download .` | silently does nothing | files are already materialised |

  Materialised files are still sync-root files. **Absence of placeholders is not
  absence of iCloud**, and reasoning from those three checks is what produced the
  earlier "the tree is not cloud-managed at all" conclusion.

  **The one reliable detector — check this FIRST:**

  ```bash
  ps -eo pid,time,%cpu,comm | grep '[b]ird'
  ```

  Cumulative CPU in the **hundreds of minutes** means `bird` is the bottleneck and
  nothing inside the sync root will run at normal speed. Confirm on the stalled
  process itself with `ps -o etime,time,%cpu -p <pid>`: **minutes elapsed against
  ~0.00s of CPU** is starvation, not work.

  **Diagnose in this order.** The previous ordering put iCloud last *and
  explicitly ruled it out*; that ordering is what produced three wrong diagnoses.
  Each of causes 2–4 is real and has genuinely happened here, which is why fixing
  one gave partial relief and read as confirmation:

  1. **`ps -eo pid,time,%cpu,comm | grep '[b]ird'`** — high cumulative CPU means
     iCloud. Move the tree out of `~/Documents`; nothing else will help.
  2. **`df -h /`** — under ~10 GiB free, treat every hang as I/O pathology and
     stop debugging the code. (Measured 2026-09-04: 7.6 GiB free of 228 GiB, with
     `~/Library/Caches` holding 22 GB.)
  3. **`sysctl vm.swapusage` + `ps aux -m | head`** — >90% swap in use, or more
     than two concurrent `tsc`/`next build`/`pnpm build`, is memory contention.
     Run at most **2 concurrent builders** on this host.
  4. **Reinstall `node_modules`** — `rm -rf node_modules && pnpm install
     --frozen-lockfile`. A healthy reinstall is **under 10 seconds**; if it is,
     the old tree was corrupt and that was your hang.
  5. Only then suspect the code.

  **A build starved by any of these emits no compile error.** It never got enough
  scheduled CPU to report one either way, so never read a silent stall as "the
  code is fine."

  **Measured before and after the move**, same commands, same machine:

  | | in `~/Documents` (iCloud) | in `~/dev` |
  |---|---|---|
  | `pnpm install --frozen-lockfile` | a full day of `ETIMEDOUT (errno -60)` | **3.6 s** |
  | `nest build` | four attempts, 13+ min each, no output | **8.7 s** |
  | `npm test` | could not be scheduled at all | **56 suites / 789 tests in 4 s** |
  | `tar -cf /dev/null <tree>` | did not finish in 10 min | **0.64 s** |

  **If a tree ever has to be moved out of a sync root again:** `mv` blocks inside
  the `rename()` syscall with **zero files open** and never completes, and
  `ditto`/`cp -R` crawl at roughly 80 files per minute because each file costs a
  FileProvider round trip. Delete every `node_modules` and build output first
  (they were **2.87 GB of the 2.9 GB total**), then either `git clone` fresh from
  GitHub — by far the fastest, and it is why the branches must always be pushed —
  or stream the remainder with `tar -cf - . | (cd <dest> && tar -xf -)`, which
  pays the FileProvider cost once instead of per file.

---

- **There is no `timeout` command on this Mac.** `timeout 110 grep -rn "x" .` exits
  **127** and prints **nothing** — indistinguishable from a grep that found no matches.
  On 2026-09-06 this produced two confidently-wrong conclusions in one session ("mock
  mode is closed", "there is no acceptance flow"), both false, both only caught because
  a subagent that did not use `timeout` found the truth. Never wrap a grep in it here;
  when an empty result is load-bearing, `echo "EXIT=$?"` and check for `0`, not `127`.
  `gtimeout` from coreutils would work; it is not installed.
- **Jest cannot run on this host.** It forks a worker pool and gets starved: measured
  2026-09-07 at **0.44s of CPU across 14 minutes** at 0.0%, and `--runInBand` fared no
  better. Plain single-process node scripts (`check:cjs`, `check-claims.mjs`) run fine,
  and `tsc` on the small Vite marketing project completes — it is the heavy, forking
  work that dies. **Vercel's remote build is the gate that actually works** here; it
  compiles, it does not run tests.

---

## 15. Working agreements

- **Confirm before deploying** `immistack-marketing` (live domain) or running
  anything destructive against `meru-core`.
- **Never run git from the workspace root.** Stand in the repo you mean.
- **Say what is actually true.** If a screen is empty because the backend has no
  data, that is the finding — do not seed it to look better without saying so.
- **One concern per commit**, and update the relevant doc in the same commit.
- The frontend→backend request ledger lives in `meru-core-fe/AGENTS.md` §11 and is
  copied by hand into `meru-core/AGENTS.md` §8. That handoff is manual; do it.
- A "GovernanceX — 143 features" report is circulating that describes a different
  system (React 19 / Express / tRPC / MySQL-TiDB, 216 tables). Of 38 named
  features checked against the live spec, **four** had a backing route. Do not
  scope from it.

---

## 16. Known gaps worth carrying in your head

These are verified against the code, not inherited from prose. Each is recorded
in the owning repo's docs with detail.

### Safety findings first — these outrank features

| Finding | Status |
|---|---|
| **Document access control was a no-op.** `DocumentHubService.canAccessDocument` ended in `return true; // Simplified for now`. RLS scopes to the tenant, not the user, so inside one tenant any user could read any document — on ImmiStack, one applicant reading another's passport. The fourth instance of the class that already shipped on `/crm/entities`, `/payments` and `/communications/threads`. | **FIXED 2026-08-22.** `src/documents/document-access.service.ts` is now the single decision for both `DocumentsService` and `DocumentHubService`; 404-not-403 on an unreadable document, matching the `/payments` precedent. Spec pending. |
| ~~Screening may return "clean" for every name if `watchlist_entries` is empty~~ | **FIXED, confirmed in code 2026-09-08.** `src/ai/engines/screening.engine.ts:203-216` throws `ScreeningListsUnavailableException` — HTTP **503** with `listsLoaded: false` — when `watchlist_entries` is empty or unreadable; it does not fall through to a clean result. The ImmiStack frontend (`components/screening/screening-panel.tsx`, `hooks/api/use-screening.ts`) reads `listsLoaded`/`watchlist-status` and disables the Screen button on it. `CRON_SECRET` is set and the daily cron is authorised, so ingest should keep the table populated regardless; **still verify with `GET /engines/screening/watchlist-status`** (`entries`, `ingested`) if a 503 is seen, since that is the operational signal, not the failure mode. **Note:** older prose demands `SCREENING_LISTS_URL`, which nothing reads — `WatchlistIngestService` fetches hardcoded public OFAC/UN feeds. |
| **Storage access was inverted** — `storage.service.ts` `checkAccess` denied everyone but the owner, the opposite wrong answer to the document stub. Staff could not reach their own tenant's files. | **FIXED 2026-08-22.** Same `scopeOf` model as documents; 404-not-403 on an unreadable private file. `StorageService` also stopped hardwiring S3 — a `StorageDriverRegistry` resolves the driver per file and per tenant, which is the seam the Supabase migration drops into. |
| **Swagger advertises `x-api-key`** as a security scheme; no route, strategy or guard enforces it. | **FIXED** — `src/swagger.ts` no longer declares the scheme. |
| **Citation enforcement is per-controller**, not global — every `/engines/*` route, `POST /documents/:id/analyze` and two `/orchestration/*` routes bypass it despite the stated "all AI responses are cited" rule. | **FIXED** — `CitationEnforcementInterceptor` is on `EnginesController`, `OrchestrationController` and `DocumentsController`. |
| **`GET /orchestration/health` hardcodes `crm: true, search: true`** and only probes AI. | **FIXED** — probes `CrmService.probe()` / `SearchService.probe()`. |
| **`SearchService` never delegates to Elasticsearch** — it is a Postgres `ILIKE` facade; `ElasticsearchService` is real and imported but is a parallel route-only silo. | **FIXED 2026-08-22.** `SearchService` mirrors every index write to ES when the boot ping succeeded (`ElasticsearchService.available`) and queries ES first with Postgres ILIKE as the fallback. Same result shape. Postgres `search_index` stays the source of truth. ES is live only when `ELASTICSEARCH_HOST` points at a reachable cluster — **it is not set on Vercel today**, so production still answers from Postgres and says so in the log. |

### Architecture gaps

| Gap | Where |
|---|---|
| **Pack `workflows[]` were inert end to end.** | **FIXED 2026-08-22.** `PackWorkflowService` (`src/workflow/services/`) materialises a pack's workflows into `workflows`/`workflow_states`/`workflow_transitions` rows per tenant — `POST /workflows/pack/materialise` (firm/platform admin, idempotent on `triggerConfig.pack.workflowId`), `GET /workflows/pack` lists the definitions. Step `condition` strings compile to JsonLogic via `compileCondition` (grammar: `<path> <op> <literal>`, `in [...]`, `not in [...]`, or a JsonLogic object — **no eval**) and `WorkflowEngineService.evaluateConditions` now evaluates `conditions.jsonLogic` through `RuleEvaluatorService`. A condition that does not compile is stored as `conditions.unevaluable` and that transition **never opens** — visible authoring error, not a silent allow. Materialisation is operator-triggered, not automatic: a pack version bump does not rewrite a workflow with live instances. |
| **Country pinning changed nothing on any read path.** | **FIXED 2026-08-22.** `VerticalPackService.forVertical` consults `tenant_config_pins` for the ambient `TenantContext` tenant and serves the pinned pack when it is active and of the same vertical; otherwise the base pack. Outside a request (jobs, bootstrap) there is no tenant and the base applies. Pin `overrides` are still not merged on this path. |
| **`rules[]` was validated, stored, and read by nobody.** | **FIXED 2026-08-22.** `PackRuleService` (`src/rules/`) evaluates `rules[]` against a record — `GET /crm/entities/:id/rules` → `{pack, evaluated, invalid, skipped, violations, blocked}`. Read-only by design (§7.2): nothing blocks a write. `skipped` are rules the evaluator refused because the record lacks a compared field — **unknown, not passed**. Neither vertical pack ships a `rules[]` yet, so the report is empty until one is authored. |
| **Entitlements were cosmetic** — no `ModuleCode`, no `@RequiresModule`, no 402. | **FIXED 2026-08-22, GRC routes only.** `src/iam/entitlements/`: `ModuleCode` (all 13 existing codes kept, plus `screening`, `trade_finance`, `vessel_tracking`), `@RequiresModule`, `ModuleEntitlementGuard` → HTTP **402** `MER-TENANT-0006` with `missingModules`. Applied to `/integrations/trade*` and `/integrations/vessel*` and `/engines/vessel/*`. **Not** applied to `/engines/screening` — it is vertical-neutral and ImmiStack calls it. Stacking safeguard: a grant listing **no** GRC code predates the vocabulary and passes ungated (logged); only grants issued with GRC codes are enforced. GRC tenants provisioned from now on get GRC codes by plan; existing grants are untouched. |
| **No tenant-domain resolution.** | **FIXED 2026-08-22.** Public `GET /tenants/resolve?host=` → `{slug, name, vertical, logoUrl, branding.colors, matchedBy}` or 404. `<slug>.<BASE_DOMAIN>` by slug (reserved labels excluded), otherwise exact match on `settings.branding.customDomain`. Nothing else is returned to an anonymous caller. |
| **ImmiStack hardcodes its navigation** | **FIXED** — `immistack/lib/api/services/navigation.service.ts` renders from `GET /config-packs/me/navigation`, old list kept as an honest fallback. |
| **Tokens lived in `localStorage`** in all three product apps; GovX stored them **twice** | **FIXED 2026-08-22** — httpOnly session cookie via `lib/api/session-cookie.server.ts` in each app. |
| **`/api-json` census** | **274 paths / 326 operations**, verified 2026-09-08 (was 273/325 on 2026-09-05 — `auth` -1 for the removed `/auth/register`, `alerts` +2, new prefix). Any doc still quoting 248/257/262/272/273 predates this pass. |

### 2026-09-05 — fixes landed and findings still open

Committed locally on `fix/crm-entity-actor-scoping` (10 commits, not yet merged — see
`meru-core/AGENTS.md` header for the merge/deploy state):

| Fixed | Detail |
|---|---|
| Unauthenticated `/api/__diag` in production | Was returning secret **lengths** with no guard, and `?db=1`/`?boot=1` opened a live DB connection / full boot unauthenticated. Now gated (hermetic check + rate limiter, e2e-tested 8/8 + 3/3). |
| No rate limiting on `/auth/*` in the Vercel entrypoint | `src/main.ts` had a limiter; `api/index.js` — what Vercel actually serves — did not. Fixed alongside the diag gate. |
| Regulator adapters not gated by vertical/tenant enablement | Now gated; adapter health and AI capability reported honestly. |
| AI-insight reads scoped to tenant only, not the acting user | Orchestration reads now scope to the acting user, with a spec. |
| `AddInboundWebhooks` migration on disk but missing from `ALL_MIGRATIONS` | **Fourth recurrence** of this exact class of bug in this file. Registered; `src/webhooks/*` was already wired and shipping 500s where the table didn't exist. |
| `documents.service.ts:535` unguarded `currentVersionId` null → 500 | Fixed with a null guard + a reversible migration relaxing the NOT NULL constraint. |
| `POST /auth/register` | **Removed**, not repaired — it was `@Public()`, keyed on a guessable tenant slug, and would have let anyone self-provision into another firm's or bank's tenant. `POST /tenants/signup` and `POST /iam/users/invite` are the two supported paths. |

Still open, found today, not yet fixed:

> ### The config packs in production are three minor versions stale, and nothing re-seeds them
> **Found 2026-09-08, verified against the production database.**
>
> `config_packs` holds `immigration` and `au-immigration` at **v2.3.0**. On disk they are
> **2.6.0** and **2.8.0**. The live rows carry **`rules = 0`** in their stored `schema` jsonb —
> so the VAC compliance rule, the whole point of the R1 money-integrity release, **has never
> been evaluated in production**, along with `vacSettlementMode`'s `lockedWhen` immutability and
> everything else authored since v2.3.0.
>
> **Why:** `SKIP_CONFIG_PACK_LOADER=true` is set on Vercel Production (`vercel env ls`), so
> `ConfigPackLoaderService` returns at `config-pack-loader.service.ts:66` and never re-seeds at
> boot. The packs were loaded once, 43 days ago, and a version bump on disk reaches nothing on
> its own. **Bumping a pack version is not shipping it.**
>
> **This is not a §7.3 violation — the UI is honest about it.** `compliance-rules-panel.tsx:76-80`
> renders "`<code> v<version>` does not declare any rules[] yet — this is not the same as
> 'no violations'", naming the live version. A caseworker is told the gate is not armed rather
> than shown a clean result. The defect is that the gate is inert, not that it lies.
>
> **Remedy — operator action, one call.** Either:
> `POST /api/v1/jobs/packs/reload` with `Authorization: Bearer $CRON_SECRET` (set on Vercel), or
> `POST /api/v1/platform/config-packs/reload` as `platform_admin` (`platform.controller.ts:63`,
> God View, audited). Then re-check `SELECT code, version FROM config_packs`. I could do neither:
> `CRON_SECRET` is empty in the local `.env`, and I do not enter credentials.
>
> **After reloading, expect real behaviour change**, so do it deliberately rather than
> incidentally: the VAC rule begins reporting violations, and `lockedWhen` starts **refusing**
> a `vacSettlementMode` write after lodgement (`crm.service.ts:177-183`, a 409). Both are
> intended R1 behaviour; neither has ever run against live data.



| Finding | Severity | Detail |
|---|---|---|
| ~~`/tasks` has no `@Roles` and no user-scoping~~ | **FIXED — verified in code 2026-09-07** | `task.controller.ts:36` carries `@UseGuards(AuthGuard('jwt'), PolicyGuard)`; `task.service.ts` imports `scopeOf` and applies own-scope on read (`:114`, `:169`), and `findTaskOrThrow` filters `{ id, tenantId }`. `task-authz.spec.ts` exists. This row and its twins in `meru-core/CLAUDE.md` sent three separate agents to re-verify a closed finding — **stale blockers cost real time.** |
| ~~`GET /health/capabilities` role check is inert~~ | **FIXED — on `main`, verified 2026-09-07** | `health.controller.ts` now carries `@UseGuards(PolicyGuard)` alongside `@Roles(PlatformRole.PLATFORM_ADMIN)`, which is ADR 0007 D4's end state, not the interim in-handler check. The earlier caution — that `HealthModule` would have to import `IamModule` — was wrong: `CoreModule` is `@Global()` and exports `VerticalPolicyService`, so `PolicyGuard` resolves anywhere, as `TasksModule` already demonstrates. |
| ~~`TaskService.getTask` has no `tenantId` filter~~ | **FIXED — verified 2026-09-07** | `findTaskOrThrow` filters `{ id, tenantId }` (`task.service.ts:84-96`) and `getTask` goes through it. |
| ~~`capabilities.service.ts` checks `UK_HOMEOFFICE_CLIENT_ID`; the adapter reads `UKVI_*`~~ | **FIXED 2026-09-07 — and it was 7 of 8 rows, not 1** | Checking the other seven found the same class in six more. `sa-sama`, `qa-central-bank` and `bh-central-bank` required a `*_API_KEY` no adapter reads (all three use `*_CLIENT_ID` + `*_CLIENT_SECRET`); `au-home-affairs`, `ca-ircc` and `nz-immigration` required the client id but **not the secret**, while `credentialsPresent` needs both — so setting only the id made the report say `live` about a connector still running **sandboxed**, which is the §7.3 failure exactly. Only `ae-cbuae` was correct. Unreachable from behaviour (with nothing set, every adapter reads `unconfigured` whichever variable is named), so the fix ships with `capabilities-regulators.spec.ts`, which parses each adapter's own `credentialsPresent` expression and fails on divergence — proven to fail when the original UK row is reintroduced. |
| ~~`npm test` and `rls:verify` never run on this host~~ | **BOTH CLOSED 2026-09-08** | `npm test` runs in seconds from `~/dev/meru` (**63 suites / 849 tests green**); it immediately caught 10 failing tests nobody could see, where two specs still mocked the CRM repo as `find({ where: { assignedTo } })` after `ownedEntityIds` was rewritten to build a query. **Tenant isolation is now PROVEN, not merely configured:** `BASE_URL=https://meru-core.vercel.app bash scripts/smoke/cross-tenant.sh` → **10 passed, 0 failed** against production — two real tenants, neither able to list, fetch by id, or read stats across the boundary. Verified alongside it: `DATABASE_APP_URL` **is** set on Vercel Production (43 days), and `meru_app` holds `rolbypassrls=false` — so production genuinely runs under the RLS-enforcing role, and RLS is not inert. `rls:verify` still cannot run *locally* (the local `.env` has `DATABASE_APP_URL=""`), and **do not "fix" that by running `scripts/provision-rls-role.js`: it `ALTER`s `meru_app`'s password and would break production until Vercel's variable was updated by hand.** The HTTP proof is the correct route and needs no secret. One check remains skipped — intra-tenant client-to-client isolation — because no route returns an invite acceptance token to a script (ADR 0006); that is a *tooling* gap, not an isolation finding. |
| Two `sweep-pilot-*` tenants left `suspended`, no delete route | Owen (CRUD suite) | `TenantProvisioningService.deleteTenant` exists, unwired, with an incomplete hard-purge branch. Needs wiring before pilot tenants can be cleaned up. |
| Client-thread cross-client isolation **untested**, not unsound | Owen (CRUD suite) | The code is right per ADR 0005. **`RESEND_API_KEY` and `RESEND_FROM` are now set** (confirmed 2026-09-08) — the blocker on creating staff/client accounts via the invite flow to prove this live is gone. Test is still not run; this is now the top priority, not blocked on a credential. |
| Dependency advisories | **multer FIXED 2026-09-07**, rest open | `multer` bumped 1.4.5-lts.2 → **2.0.2** and it is now the only version in the tree; `check:cjs` passes with it (52 packages, no ESM-only dep — the gate that has caught `uuid` and `otplib` before). Still open: `@nestjs/core@11.1.12`, `typeorm@0.3.28`, and the 17 Dependabot alerts on the marketing repo. **Correction: `axios` is not a dependency of `meru-core`** — absent from `package.json` and the lockfile; that finding belongs to the frontend repos. |
| Sweep account **passwords** were committed in-repo | **Partly fixed 2026-09-07** | Passwords now read from env and `tools/sweep/lib.mjs:28-38` throws if unset; the three **emails** are still hardcoded at `:36-38`, which is fine. What remains open is the operator action: the historical passwords are still in git history and have **not been rotated on production**, and one of the three accounts is `platform_admin`. |
