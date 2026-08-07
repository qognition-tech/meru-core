# Keeping `meru-core-fe` in step with the backend

> How the three UIs consume this API, how to find out what changed, and the
> rules that keep a demo build from lying to a user. Written for whoever picks
> up `meru-core-fe` next — human or agent.

---

## 1. Where the truth lives

| Question | Answer |
|---|---|
| What routes exist right now? | `https://meru-core.vercel.app/api-json` (OpenAPI) or `/api` (Swagger UI). **Generated from the code**, so it cannot drift. |
| What changed and why? | `MERU-FE-BE-HANDOFF.md` in the repos' parent directory. Append-only, newest section last. |
| What is deliberately not built? | `docs/MASTER_GAP_ANALYSIS_AND_PLAN.md` §4 "Honest remaining scope" |
| Why can't we call a regulator for real? | `docs/REGULATOR_API_ACCESS.md` |

**Probe before you build.** A route "exists" if it returns 401 (present, needs
auth) or 400 (present, validating) — not 404. Probe with the verb the route
uses: a GET against a POST-only route returns 404, not 405, and has caused a
wasted round of "the endpoint is missing" before.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://meru-core.vercel.app/api/v1/engines/screening
# 401 => exists.  404 => not deployed yet.
```

---

## 2. The five rules that matter

**1. Never render mock data as real.** An empty API response means *no
records* — render an empty state. A mock fallback is indistinguishable from
real rows exactly when something is broken. Each app has a `notImplemented()`
seam for genuinely missing routes; it throws in production and renders an
explicit "not available yet" panel.

**2. Unknown is not clear.** This is the one that can actually hurt someone:
- Vessel risk: `riskScore`/`riskLevel` `null` with `live: false` means the AIS
  source is unavailable. Never draw a green indicator from a null.
- Screening: call `GET /engines/screening/watchlist-status` first. `entries: 0`
  means only built-in samples are loaded and a real sanctioned name **cannot**
  match. Show "lists not loaded", not "no hits".
- Doc-intel: check `modelUsed`. A heuristic fallback caps confidence at 0.45
  deliberately, to force human review when no vision model is configured.
- AI answers: `citationEnforced: false` means the citation guard suppressed a
  generated answer. Label it unsourced; never present it as verified.

**3. Adapters fill defaults field by field.** Records created through the
generic CRM API carry only what their author sent. Build them with `??` per
field — never spread a value cast to the full type over your defaults, because
an explicit `undefined` then wins and silently erases every fallback. This has
already caused one page-crashing `TypeError` (`lead.fields` undefined).

**4. A 200 can be a failure.** `POST /orchestration/agents/:id/run` returns
HTTP 200 with `status: "failed"` and an `error` when the agent fails — the
*request* succeeded, the *run* did not. Render it. Likewise the response
envelope carries `error` alongside `data`; all three API clients already throw
on a populated `error` at 200.

**5. 503 from billing is configuration, not an outage.** `POST /billing/checkout`
returns 503 while `STRIPE_SECRET_KEY` is unset. Render "billing not configured".

---

## 3. Shapes you will use constantly

**Envelope** — `{data, meta, error}`, unwrapped by each app's axios
interceptor. Pagination is in `meta.pagination`
(`page, pageSize, totalItems, totalPages, hasNext, hasPrevious`); use
`apiGetWithMeta` when you need the counts. **Reading `data` and dropping the
counts is why paginated lists show page 1 with no total.**

**One generic record resource.** Cases, leads, obligations, breaches, vendors,
control tests, risk scenarios, milestones, RFIs, screening matches, knowledge
articles, training modules and turnover records are **all**
`/crm/entities?type=X`. There is no `/cases`, `/leads` or `/obligations`, by
design (CLAUDE.md §11.3 — the horizontal engine must not learn a vertical's
vocabulary). Generic lifecycle is
`open|in_progress|blocked|resolved|closed|cancelled`; vertical-specific fields
live in `verticalAttributes`, which **merges on PATCH** — send only what changed.

**Field definitions come from the config pack**, not from your code.
`GET /config-packs` → the banking pack's `entityTypes[]` carries
`{type, label, pluralLabel, workable, statusLabels, fields[]}`. Render tables
and forms *from that*. Hardcoding a field list per page is the exact thing
Layer 4 exists to prevent — and if you hardcode it, a pack update silently
stops reaching users.

**Entitlements gate the UI.** `GET /tenants/me/entitlements` →
`{vertical, plan, status, modules[], connectors[]}`. Gate nav and feature
screens on `modules`. Do not infer entitlement from plan name in the frontend;
the backend already froze the grant at provisioning.

---

## 4. The four engines — same routes for every app

Previously unreachable from ImmiStack; now shared. Full request shapes in
`MERU-FE-BE-HANDOFF.md` §11.

- `POST /engines/screening` — GovX screens counterparties, ImmiStack screens
  visa applicants. Same call.
- `POST /engines/doc-intel` — GovX reads trade invoices and bills of lading,
  ImmiStack reads passports and payslips. Same call.
- `POST /engines/vessel/risk`, `GET /engines/vessel/lookup`
- `POST /engines/radar/scan` — results are `pending_review`; nothing
  auto-applies to a tenant (human-in-the-loop, CLAUDE.md §3.1).

`/integrations/{country}/screening` is a **different thing** — it calls a
regulator's own screening service through a country adapter. Use `/engines`
for "is this name sanctioned".

---

## 5. Connectors, and being honest about sandbox

`GET /integrations/connectors` returns the regulator adapters for the caller's
vertical (GovX: CBUAE, SAMA, QCB, CBB — ImmiStack: AU Home Affairs, IRCC, UK
Home Office, INZ) with `{enabled, mode, hasCredentials, sandbox, capabilities}`.
`PUT /integrations/connectors/:code` takes `{enabled?, mode?, credentials?}`;
credentials are write-only and never returned.

**Every adapter is currently sandbox.** Per `docs/REGULATOR_API_ACCESS.md`,
going live needs licensing, not code. A connector in sandbox must keep its
SANDBOX badge — a UI implying live regulator data is the worst failure mode
this product has, because a compliance officer will act on it.

---

## 6. Working alongside other sessions

Three agents and a human may push to `meru-core-fe` concurrently.

- `git pull` **before starting and before every commit**.
- Stay in your app directory. Cross-app edits cause conflicts nobody expects.
- Typecheck before committing: `npx tsc --noEmit -p tsconfig.json` in the app
  directory. It is slow (4–7 min) — batch 2–3 pages per run.
- Dev ports are deconflicted: dashboard 3000, governancex 3001, immistack 3002.

## 7. What is NOT shared between the apps

Worth knowing before you reach for something that isn't there:

- **No SSO.** Separate cookies, separate localStorage keys, separate logins.
- **`packages/ui` is dead code** — nothing imports `@meru/ui`. Every app has
  its own `cn`, api client, stores and shell. Do not start importing it
  without a decision to consolidate.
- **Toasts**: dashboard and immistack have `sonner`; **governancex does not** —
  use local state notices there (see `components/settings/connectors-tab.tsx`).
- **i18n**: governancex uses next-intl with `/[locale]/` routes and en+ar;
  immistack has next-intl installed but unused; dashboard has none.
