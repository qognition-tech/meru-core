# Architecture Decision Records

There was no ADR directory in this repo before 2026-09-03. This proposes the convention.

## Naming

`NNNN-kebab-case-title.md`, zero-padded to four digits, allocated in order. Never renumber
a merged ADR — a stale link to `0007` must not resolve to a different decision.

> **0008 is the one exception, and the reason for this rule.** `0008-vac-payment-integrity.md`
> was drafted as `0001` on a since-superseded branch (`fix/crm-entity-actor-scoping`) that never
> reached `main`, in parallel with an unrelated `0001-practice-role-tags.md` that did. It was
> rescued and renumbered to `0008` on merge into `main` rather than left to collide — see its
> own rescue note. It was never published under `0001` anywhere a link could have formed, which
> is why this was safe to do once and must not be repeated.

## Required sections

1. **Status** — Proposed | Accepted | Implemented | Superseded by NNNN. Dated.
2. **Context** — what forced the decision, with `file:line` or an `/api-json` path for
   every load-bearing claim. Anything unverified is marked `[UNVERIFIED: <thing>]` inline.
3. **Decision** — one sentence per decision, then the detail.
4. **Options rejected** — and why. The rejected option is the part future readers need.
5. **Consequences** — including the unpleasant ones.
6. **What would make this wrong later** — the trigger to revisit. Without this it is a
   record, not a decision.
7. **Rollback** — in this document, not a separate one.

## Scope

An ADR belongs here when the decision is expensive to reverse: schema, tenancy, auth,
anything on a public API, anything touching the pack contract. Decisions that span
`meru-core`, `packages/config-packs` and a frontend app live here because the pack and the
core both live in this repo; the frontend app docs link to the ADR rather than restating it.

## Index

Verified against `docs/adr/` on disk, 2026-09-08.

| # | Title | Status | Owner |
|---|---|---|---|
| [0001](0001-practice-role-tags.md) | Practice roles as additive vertical tags on `User` | **Accepted** — executable contract | Kyle (architect); implementation Luke; gate Owen |
| [0002](0002-neon-auth-federation.md) | Neon Auth federation (post-pilot) | Proposed — 2026-09-05, not merged | Requires `secops` (Anton) + `quality` (Owen) review |
| [0003](0003-ai-provider-abstraction.md) | Platform AI provider abstraction, and three agentic features | Proposed — 2026-09-05, not merged | Requires `quality` (Owen), and `secops` (Anton) for the audit/citation write path |
| [0004](0004-upstash-redis-qstash.md) | Upstash Redis (REST) for rate limiting, revocation and idempotency; QStash as the minute scheduler | Proposed — 2026-09-05, not merged | Requires `quality` (Owen); `secops` (Anton) for revocation/idempotency |
| [0005](0005-communications-thread-scoping.md) | Communications thread scoping: ratify what shipped, close what did not | Proposed — 2026-09-05, not merged | Requires `quality` (Owen) + `secops` (Anton) |
| [0006](0006-operator-invite-link.md) | Operator invite-link retrieval and regeneration | Proposed — 2026-09-05, not merged | Requires `quality` (Owen) + `secops` (Anton) |
| [0007](0007-operator-console-and-record-lifecycle-contracts.md) | Operator console and record-lifecycle contracts | Proposed — 2026-09-05, not merged | Requires `quality` (Owen) + `secops` (Anton) |
| [0008](0008-vac-payment-integrity.md) | VAC and payment integrity (ImmiStack Tier 1.1–1.4) | **Implemented** (core) — `vacStatus`, `vacSettlementMode`, field-level immutability, first `rules[]` entry and the `BackfillVacStatus` migration are on `main` and applied to production. Card-authority/PAN redaction (§4.3) and the duty floor (§4.5) not found in `src`/`packages` as of 2026-09-08 — still open | Rescued from a superseded branch; not formally re-gated by Owen against this document |

**Reading `main`'s money model:** the ADR to cite for `vacStatus`, `vacSettlementMode`,
card-authority/PAN redaction and the duty floor is **0008**, not 0001. `0001` is the practice-role
tagging decision and has nothing to do with payments.
