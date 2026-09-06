# 0003 — Platform AI provider abstraction, and three agentic features

**Status:** Proposed — 2026-09-05. Not merged. Requires review by `quality` (Owen) and, for
the new write path on `entityTypes[].fields[]` audit/citation behaviour, `secops` (Anton),
per `definition-of-done.md`.

**Scope:** replacing the platform's hardcoded `OPENAI_API_KEY` fallback with an operator-set,
DeepSeek-default provider; giving `doc-intel.engine.ts` the same per-tenant/platform routing
`AiService` already has; an honest embeddings story; and the contract for three new
agentic features named by the operator (intake summariser, checklist-gap agent, matter status
narrative).

---

## 1. Context

### 1.1 What already exists and must be built on, not duplicated

**The per-tenant connector mechanism is already built and already includes DeepSeek.**
`AI_PROVIDER_ADAPTERS` (`src/integrations/services/connectors.service.ts:46-105`) lists
`openai`, `anthropic`, `deepseek` and `custom-openai-compatible`, each with a `defaultBaseUrl`
and `defaultModel`. The DeepSeek entry is already `defaultBaseUrl:
'https://api.deepseek.com/v1'`, `defaultModel: 'deepseek-chat'` (`:71-92`) — **this ADR does
not invent that registry, it extends what routes to it.** `ConnectorsService.resolveAiProvider`
(`:180`) decrypts a tenant's chosen connector; `AiService.clientFor`
(`src/ai/ai.service.ts:483-527`) checks it **before** the platform key, so a tenant that has
connected its own DeepSeek key already gets a working AI gateway with zero platform
credential set. `PUT /integrations/connectors/openai` (per the operator's framing) is really
`PUT /integrations/connectors/{code}` for any code in `AI_PROVIDER_ADAPTERS`
`[UNVERIFIED: the exact route path — not read directly in this pass; the entity and service
are confirmed, the controller path is inferred from the module name and should be grepped
before Luke builds against it]`.

**What genuinely does not exist:** a way for the *platform default* (used when a tenant has
connected nothing) to be anything other than OpenAI via a bare env var, set once at deploy and
never rotatable without a redeploy. `AiService`'s constructor
(`ai.service.ts:131-139`) and `clientFor`'s fallback (`:508-520`) both read only
`process.env.OPENAI_API_KEY`, hardcoded to the OpenAI SDK's default base URL. `GET
/health/capabilities`'s `evaluateAi` (`src/health/capabilities.service.ts:315-356`) reports
this same env var, correctly distinguishing `live`/`degraded`/`unconfigured` by counting tenant
connectors (`:284-308`) — **that reporting logic does not need to change**, only what it is
reporting on.

### 1.2 Three findings that shape the design

**F1 — `doc-intel.engine.ts` builds its own, disconnected OpenAI client.**
`DocIntelEngine`'s constructor (`src/ai/engines/doc-intel.engine.ts:182-185`) reads
`OPENAI_API_KEY` directly and constructs `new OpenAI({apiKey})` — bypassing `AiService.clientFor`
entirely. A tenant that has connected DeepSeek or Anthropic gets a working `AiService.execute`
and a **hard failure on document analysis** the moment the platform key is unset, because this
engine never looks at the tenant's connector. This is the single largest inconsistency this
ADR closes.

**F2 — DeepSeek has no embeddings endpoint.** Verified against DeepSeek's own API
documentation: the base URL is `https://api.deepseek.com/v1` (or `/beta` for beta features),
chat completions live at `/v1/chat/completions`, and — checked directly —
**"DeepSeek does not currently support embeddings of content"**
([api-docs.deepseek.com](https://api-docs.deepseek.com/)). `AiService.createEmbedding` and
`semanticSearch` (`ai.service.ts:231-274`, `:276-316`) both hardcode
`model: 'text-embedding-3-small'` against `this.openaiClient` specifically — **not** against
whatever `clientFor` resolved. So today, embeddings already implicitly require an OpenAI key
regardless of what a tenant has connected, and that is *correct* given F2 — it just is not
stated or reported as its own capability, so a tenant on DeepSeek-only sees semantic search fail
with a generic "AI is not configured" 503 that blames the wrong thing.

**F3 — every pack `prompts[]` entry pins `model: 'gpt-4o-mini'`.** Confirmed in
`AiService.executeOpenAI`'s own comment (`ai.service.ts:538-545`): *"every prompt in both
vertical packs pins `gpt-4o-mini` regardless of vendor."* The existing precedence — tenant
connector's own model wins over the pack's pin — already handles this correctly for a
DeepSeek-connected tenant. **The platform default changing to DeepSeek must not disturb this
precedence**; it only changes what "platform" resolves to when no tenant connector exists.

### 1.3 The pack contract, checked

`prompts[].model` is optional per `PackPrompt` `[UNVERIFIED: exact Zod shape of PackPrompt —
inferred from usage at ai.service.ts:414-419 (match.model, match.temperature, match.maxTokens,
match.provider); read packages/config-packs/_schema/pack.schema.ts before authoring against
this]`. No schema change is needed for anything in this ADR — the model-selection precedence
already exists in code, not in the pack schema.

---

## 2. Decisions

### D1 — a platform AI provider is operator-configurable, encrypted at rest, defaulting to DeepSeek

**Decision.** A new single-row table, `platform_ai_settings`, holds the platform's default AI
provider — the thing `clientFor` falls back to when a tenant has connected nothing. Reuses the
existing `CipherEnvelope` / `encryptCredentials` / `decryptCredentials` machinery
(`src/core/crypto/credential-cipher.ts`) already used for `TenantConnector.credentials`, rather
than inventing a second encryption scheme.

```ts
// New entity, src/ai/entities/platform-ai-setting.entity.ts
@Entity('platform_ai_settings')
class PlatformAiSetting {
  @PrimaryColumn({ default: 'default' }) id: string; // always 'default' — single row, no tenantId
  @Column() adapterCode: string;          // one of AI_PROVIDER_ADAPTERS' ids
  @Column({ nullable: true }) baseUrl: string | null;
  @Column({ nullable: true }) model: string | null;
  @Column({ type: 'jsonb', nullable: true }) credentials: CipherEnvelope | null; // apiKey, encrypted
  @Column({ nullable: true }) updatedBy: string | null;  // users.id of the operator who last set it
  @UpdateDateColumn() updatedAt: Date;
}
```

**Why a new table and not a `tenantId: null` row on `tenant_connectors`.** `tenant_connectors`
declares `tenantId: uuid NOT NULL` (`tenant-connector.entity.ts:29-31`), and every RLS policy
in this codebase assumes a tenant-scoped table has a real tenant. A nullable `tenantId`
sentinel on an otherwise-tenant-scoped table is exactly the ambiguity workspace `CLAUDE.md`
§8 exists to prevent — "every tenant-scoped table has a `tenantId` column" is a promise this
table would break for the sake of reusing one entity. A dedicated table with **no** `tenantId`
column at all is the honest shape: this is platform-global configuration, not tenant data, and
it needs no RLS policy — it is read only by `AiService` (server-side) and written only by a
`platform_admin` route (D2).

**Default value.** Seeded (by migration, not by application boot logic — see §3) as
`{adapterCode: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
credentials: null}`. With no credentials, `AiService.clientFor`'s platform path stays
`unconfigured` exactly as it does today with no `OPENAI_API_KEY` — the seed changes *what*
the platform defaults to once an operator supplies a key, not whether AI works before they do.

**Resolution order in `clientFor`, updated:**

1. Tenant's own connector (`ConnectorsService.resolveAiProvider`) — **unchanged**, still wins.
2. Platform setting (`PlatformAiSetting`, this ADR) — **new**, replaces the bare env-var read.
3. `ServiceUnavailableException` naming both remedies — unchanged in spirit, message updated to
   name the platform route instead of an env var.

**`OPENAI_API_KEY` is not removed.** It becomes a **migration seed source only**: if
`platform_ai_settings` has never been set by an operator (`updatedBy IS NULL`) and
`OPENAI_API_KEY` is present in the environment, `clientFor` falls back to it one more time
before failing — this is what makes the change additive rather than a flag-day cutover for any
deployment that already relies on the env var. Once an operator calls `PUT /platform/ai-provider`
even once, `updatedBy` is non-null and the env-var fallback is never consulted again.

### D2 — one audited, platform_admin route; the key is never returned

**Decision.**

```
PUT  /platform/ai-provider     (platform_admin, runAsGod, CRITICAL audit)
GET  /platform/ai-provider     (platform_admin)
```

`PUT` body:

```jsonc
{
  "adapterCode": "deepseek | openai | anthropic | custom-openai-compatible",
  "baseUrl": "https://api.deepseek.com/v1",   // required for custom-openai-compatible
  "model": "deepseek-chat",
  "apiKey": "sk-…"                             // optional — omit to keep the existing key
}
```

`PUT` response and `GET` response, identical shape, **never the key**:

```jsonc
{
  "adapterCode": "deepseek",
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "hasCredentials": true,
  "updatedBy": "<users.id>",
  "updatedAt": "<ISO-8601>"
}
```

Mirrors `TenantConnector`'s own contract exactly — `hasCredentials`, never `credentials` — the
same reason `GET /integrations/connectors` already withholds it. `PUT` with `apiKey` omitted
**rotates nothing**; the existing encrypted value is kept, which is what lets an operator
change only the `model` field without re-entering a live key.

**Audit.** Both the controller and the audit entry follow the exact pattern already used by
`PlatformController.reloadConfigPacks` (`src/iam/platform.controller.ts:59-90`): wrap in
`TenancyService.runAsGod(req.user.id, req.user.tenantId, 'Set platform AI provider', fn)`,
which writes the `CRITICAL` audit entry **before** the write and rethrows if the audit write
fails (workspace `CLAUDE.md` §7.7) — there is no separate audit call to add; `runAsGod` is the
mechanism. `context` on that entry records `{adapterCode, model, baseUrl, keyRotated: boolean}`
— **never the key itself**, matching D4 of ADR 0001's "never log the matched text" principle
applied to secrets generally.

**Error codes.** `400 MER-VAL-0012` — unknown `adapterCode`, or `custom-openai-compatible`
without `baseUrl`. `403` — not `platform_admin` (existing `PolicyGuard` behaviour, no new
code).

### D3 — `doc-intel.engine.ts` routes through `AiService.clientFor`, closing F1

**Decision.** `DocIntelEngine` stops constructing its own `OpenAI` client. It receives an
`AiService`-shaped client resolver via constructor injection (or a narrow interface
`AiClientResolver.clientFor(tenantId?)` that `AiService` implements, to avoid a circular
module dependency between `AiModule` and wherever `DocIntelEngine` is provided) and calls it
per-request, the same way `executeOpenAI` does. This is a **pure refactor** of an existing call
site — no new route, no schema change — and it is the one item in this ADR most likely to have
a non-obvious blast radius, because every document-analysis call today silently assumed the
platform key. **Ship it behind the same reasoning as ADR 0001's D4a/D4b split**: land the
resolver change first, verify a tenant with a DeepSeek connector and no platform key can now
successfully analyze a document (today, per F1, it cannot), then treat the platform-key-only
path as the regression case to check, not the happy path.

### D4 — embeddings are a named, separately-reported capability that fails honestly

**Decision.** `createEmbedding` and `semanticSearch` gain their own capability check,
independent of `evaluateAi`: `GET /health/capabilities` reports a second entry,
`capability: 'embeddings'`, `status: 'unconfigured'` whenever the resolved provider (tenant
connector or platform setting) is `deepseek` — because per F2 it has no embeddings endpoint —
regardless of whether chat completions are `live`. A tenant or platform on DeepSeek is **not**
"AI unconfigured"; it is "AI live, embeddings unconfigured", and the two must render as two
different lines, per workspace `CLAUDE.md` §7.3's rule against collapsing distinct unknowns.

**Route-level behaviour**, unchanged in shape, corrected in reason: `createEmbedding` and
`semanticSearch` keep throwing `ServiceUnavailableException`, but the message names the actual
cause — *"The resolved AI provider (deepseek) has no embeddings endpoint. Connect OpenAI or
Anthropic for semantic search, or set the platform default to one of them."* — rather than the
generic "AI is not configured" that fires today even when chat completions work fine.

**Why not degrade embeddings to a chat-completion approximation.** Asking DeepSeek's chat model
to "summarise for search" instead of embedding is not the same capability and would silently
degrade the actual similarity search this powers into keyword-flavoured chat output. Honest
`503` is cheaper than a plausible-looking wrong answer — the same reasoning as workspace
`CLAUDE.md` §7.3 in general.

### D5 — three agentic features, all vertical-neutral in core, all through citation enforcement

**Decision.** Intake summariser, checklist-gap agent, and matter status narrative are each one
`prompts[]` category (`PromptCategory`, extended additively) resolved through the **existing**
`AiService.execute` + `resolvePrompt` two-layer precedence (tenant override, then pack) —
**no new execution path**. Each is exposed as a route on the existing `/engines/*` surface,
which already carries `CitationEnforcementInterceptor` (workspace `CLAUDE.md` §16 — "FIXED").

| Feature | Route | `PromptCategory` | What core knows | What the pack supplies |
|---|---|---|---|---|
| Intake summariser | `POST /engines/ai/intake-summary` | `INTAKE_SUMMARY` (new) | "summarise a record's recent activity into prose" — generic, takes an `entityId` | The prompt text, which fields matter for "intake" in that vertical |
| Checklist-gap agent | `POST /engines/ai/checklist-gaps` | `CHECKLIST_GAP_ANALYSIS` (new) | "given a checklist envelope (§ workspace `immistack/CLAUDE.md` §6.7 three-valued shape), narrate what is missing" | Nothing vertical-specific beyond the checklist itself, which already comes from `documentTypes[].appliesWhen` |
| Matter status narrative | `POST /engines/ai/status-narrative` | `STATUS_NARRATIVE` (new) | "summarise a record's `status`/`stage`/`dueDate` into a sentence a client can read" | The vocabulary for what a stage *means* — a pack `prompts[]` entry, not core code |

**Contract, all three, identical shape** (matches `AiResponse`, `ai.service.ts:70-78`):

```jsonc
{
  "data": {
    "result": "<prose>",
    "model": "deepseek-chat",
    "provider": "openai",           // ModelProvider enum value — see note below
    "sources": [ { "title": "...", "url": "..." } ],
    "citationEnforced": true         // false ⇒ CitationEnforcementInterceptor substituted the fallback text
  },
  "meta": { "requestId", "timestamp", "version": "v1" },
  "error": null
}
```

`citationEnforced: false` is rendered by every consumer as **unsourced**, per workspace
`CLAUDE.md` §7.3's table — never as a normal answer with a missing footnote. This is the
existing contract; these three features do not get an exception.

**Why vertical-neutral in core.** All three are "narrate this generic record" capabilities —
none of them knows what a visa or a breach is; the pack's `prompts[]` entry supplies the
vocabulary exactly as `vac_not_verified_after_lodgement` supplies immigration vocabulary to a
generic rule evaluator in ADR 0001. **Neither pack ships these prompt entries yet** — this ADR
defines the contract; authoring `prompts[]` entries for `au-immigration.json` and `grc.json` is
pack work, in a separate commit, per workspace `CLAUDE.md` §6 rule 4 (bump the `version`).

**`ModelProvider` naming note.** `ModelProvider.OPENAI` is currently the enum value returned
for *any* OpenAI-compatible call, including DeepSeek and Anthropic-via-fallback
(`ai.service.ts:433-444` — `anthropic` maps to `ModelProvider.OPENAI` today because no
Anthropic client exists). **This ADR does not fix that naming** — it is a pre-existing
imprecision, not something these three features introduce, and renaming the enum is a wider
blast-radius change than this ADR's scope. Flagged in §7 as a trigger.

---

## 3. Migration and rollback

**Migration** (new, forward and back):

```sql
-- forward
CREATE TABLE platform_ai_settings (
  id           text PRIMARY KEY DEFAULT 'default',
  "adapterCode" text NOT NULL DEFAULT 'deepseek',
  "baseUrl"     text,
  model        text,
  credentials  jsonb,
  "updatedBy"   text,
  "updatedAt"   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_ai_settings (id, "adapterCode", "baseUrl", model)
VALUES ('default', 'deepseek', 'https://api.deepseek.com/v1', 'deepseek-chat')
ON CONFLICT (id) DO NOTHING;

-- back
DROP TABLE platform_ai_settings;
```

No RLS is applied — the table carries no `tenantId` and no tenant-scoped query ever reaches it
(D1). This is itself worth Anton's attention: it is a deliberate, narrow exception to "every
table gets RLS", and the exception is that the table holds no tenant data at all, not that RLS
was skipped for convenience.

**Rollback, per change:**

| Change | Rollback | Data left behind |
|---|---|---|
| `platform_ai_settings` + route | Drop the table (above); revert the `clientFor` fallback to `OPENAI_API_KEY`-only | None — `AiService` degrades to today's exact behaviour |
| `DocIntelEngine` resolver change (D3) | Revert the commit; the engine goes back to its own `OPENAI_API_KEY`-only client | None |
| Embeddings capability split (D4) | Revert; `createEmbedding`/`semanticSearch` return to the generic 503 message | None |
| Three agentic routes + `PromptCategory` values | Remove the routes and the enum values; **do not** remove already-authored pack `prompts[]` entries in the same commit — bump the pack version down is not meaningful (workspace §6 rule 4: only strictly-greater versions apply), so instead delete the `prompts[]` entries and bump forward | Any `ai_prompts` tenant-override rows referencing the removed categories are orphaned but harmless (read by nobody) |

**Rollback verification:** re-run `GET /health/capabilities` before and after and confirm the
`ai` and `embeddings` entries report the same `status` for a deployment with only
`OPENAI_API_KEY` set and no `platform_ai_settings` write ever made — that is the proof the
migration is additive.

---

## 4. Options rejected

| Option | Why rejected |
|---|---|
| Hardcode DeepSeek as the new platform default in code, no operator route | Contradicts "AI provider is configured from meru-dashboard" — the whole point is operator control without a redeploy |
| Store the platform key in an env var per provider (`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, …) | Requires a redeploy to rotate or switch providers, which is exactly what the operator route (D2) exists to avoid; also cannot be audited the way a DB write can |
| Reuse `tenant_connectors` with a sentinel tenant id | Breaks the "every tenant-scoped table has a real tenant" invariant (workspace §8) for the sake of one row |
| Make DeepSeek's missing embeddings endpoint fail silently by routing embeddings to OpenAI regardless of the resolved chat provider | Silently spends a different vendor's credential than the one the operator configured, with no visibility — worse than an honest 503 |
| Fold the three agentic features into `AiService.execute` directly rather than named routes | Loses `CitationEnforcementInterceptor`'s controller-level attachment (workspace §16 — it is per-controller, not global); a bare `execute()` call from three ad hoc call sites would bypass it exactly as the pre-fix `/engines/*` routes once did |

---

## 5. Consequences

1. **The platform default changes from "whatever `OPENAI_API_KEY` is" to "whatever an operator
   last set, seeded to DeepSeek with no key."** A deployment that has always relied on the env
   var keeps working via the fallback (D1) until the first `PUT`, so there is no forced
   migration event — but the first operator who touches the new route commits to it.
2. **Embeddings become visibly "unconfigured" for any all-DeepSeek deployment**, which is
   *more* honest than today, not less — but it is a new line on `GET /health/capabilities` an
   operator has to notice and understand is not a regression.
3. **`DocIntelEngine`'s behaviour changes for every tenant with a connected provider and no
   platform key** — document analysis starts working where it silently 503'd before (F1). This
   is the intended fix, but it means a previously-invisible failure becomes visible success, and
   Owen should specifically test a DeepSeek-only tenant's `POST /documents/:id/analyze`.
4. **Three new prompt categories exist in core with no pack content until authored separately.**
   Calling any of the three routes before the pack ships `prompts[]` entries answers the same
   honest `no_library`/`no_match` 503/404 that `resolvePrompt` already produces for any
   unpopulated category (`ai.service.ts:162-172`) — not a new failure mode.

---

## 6. What would make these decisions wrong later

| Trigger | Which decision it invalidates | What to do |
|---|---|---|
| DeepSeek ships an embeddings endpoint | D4 | Re-check before assuming it is still unsupported; the capability split becomes a live/unconfigured toggle rather than a permanent state for that provider |
| Anthropic is wired with a real client (not routed through the OpenAI SDK) | D5's `ModelProvider` naming note | Fix `toProvider`'s `anthropic → ModelProvider.OPENAI` mapping in the same change, and re-check every place that branches on `ModelProvider.OPENAI` assuming it means literally OpenAI |
| A tenant needs two platform-level fallback providers (e.g. DeepSeek for chat, OpenAI for embeddings, both platform-wide) | D1's single-row shape | `platform_ai_settings` becomes multi-row keyed by capability (`chat`, `embeddings`), not a single default |
| The three agentic features need cross-vertical context beyond one entity (e.g. "summarise this client's whole matter history") | D5's "generic record" framing | Re-check against `AiService.gatherCrossModuleContext` (`ai.service.ts:623-672`), which already exists for exactly this and should be reused rather than re-invented |

---

## 7. Open items for the implementers

| # | Item | Owner |
|---|---|---|
| 1 | `[UNVERIFIED]` Confirm the exact route path behind `PUT /integrations/connectors/{code}` before wiring the frontend | Luke |
| 2 | `[UNVERIFIED]` Confirm `PackPrompt`'s exact Zod shape in `packages/config-packs/_schema/pack.schema.ts` before authoring the three new prompt categories into either pack | Luke |
| 3 | Author `prompts[]` entries for `INTAKE_SUMMARY`, `CHECKLIST_GAP_ANALYSIS`, `STATUS_NARRATIVE` in both `verticals/immigration.json` and `verticals/grc.json`, bump versions per workspace §6 rule 4 | Product, with Kyle sign-off on wording only |
| 4 | Confirm no existing caller relies on `DocIntelEngine` throwing when `OPENAI_API_KEY` is unset but a tenant connector exists (D3 changes this from failure to success) | Owen |
| 5 | Security review of `platform_ai_settings` — single shared platform key across all tenants without a connector, blast radius if leaked | Anton |
