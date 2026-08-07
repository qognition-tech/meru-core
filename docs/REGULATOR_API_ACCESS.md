# Regulator API access — what it actually takes to go live

> Researched 2026-08-07. The eight adapters in `src/integrations/adapters/` are
> shape-correct and run in sandbox mode. This document records what stands
> between sandbox and live for the two the business cares about first, because
> in both cases the blocker is **licensing and onboarding, not code**.

---

## 1. UAE — Central Bank (CBUAE)

### Two different things are being conflated, and it matters

`https://rulebook.centralbank.ae/.../application-programming-interfaces-apis` is
the **Rulebook** — the regulation *describing* API obligations. It is not an API
you call, and the site blocks automated fetches (403 to non-browser clients).
Reading it gives you the rules; it gives you no endpoint.

The actual programmable surface is **Open Finance**, and it is a distinct
programme with a distinct operator.

### Open Finance (the callable surface)

- **Operator:** *Nebras Open Finance LLC*, a CBUAE subsidiary. Nebras — not the
  Central Bank directly — runs the API Hub, publishes the API documentation,
  and operates the Trust Framework (participant directory, discovery,
  onboarding, authentication).
- **Access model:** a **Trust Framework**. Only authorised participants operate,
  identified by digital certificates and listed in a compliance registry.
  Consent, onboarding and dispute resolution sit in a shared infrastructure layer.
- **Status:** API Hub v2.0 and bank/insurer go-live landed around end-2025.
  Several fintechs remain pending CBUAE approval before licence issuance.

### What Meru must do to go live

1. **Obtain the relevant CBUAE licence/authorisation** as a participant. This is
   a regulatory application, not a developer signup, and is the long pole.
2. **Register with Nebras** and enter the participant directory.
3. **Obtain digital certificates** issued under the Trust Framework — the
   adapter's `authMethod: 'mtls'` is already the right shape for this.
4. **Pass sandbox certification** before production credentials are issued.

### Honest assessment

Open Finance is account-data and payment-initiation. **GovernanceX's actual
needs — sanctions screening, SAR filing, regulatory reporting — are largely a
different surface**, and some of them (SAR submission to the FIU) run through
separate channels rather than Open Finance. Before pursuing an Open Finance
licence, confirm which CBUAE interaction the product genuinely requires; it may
be reporting channels rather than Open Finance at all.

**Do not** wire `uae-central-bank` to live endpoints on the assumption that
Open Finance covers regulatory reporting. It probably does not.

---

## 2. Australia — Department of Home Affairs

### There is a real developer portal

`https://developer.homeaffairs.gov.au/public/` is a genuine API developer portal
with a product catalogue organised by **business domain**:

- **Visa** — "managing and assessing all visa applications"
- **Case** — visa compliance, detention, incident, settlement, security referrals
  (observed products include `(Case) Credentials`, `(Case) Employers`)
- **Cargo** — end-to-end cargo and border clearance
- Supporting domains: Finance, Health, Identity, Intelligence, Risk

### Access model — genuinely tiered

Plans are **not uniformly gated**. Per the portal's own documentation: *some*
plans are usable immediately; *others* are restricted and require a request
that the API administrator assesses, possibly with follow-up questions.

**This is the most encouraging finding in this document.** It means a
self-service tier plausibly exists and can be explored without a formal
partnership, which is a materially lower barrier than CBUAE.

### VEVO specifically

VEVO for organisations is reached by creating an **ImmiAccount** of type
*Organisation*, selecting *VEVO for organisations*, and having the Organisation
Account Administrator approve access. Whether that grants a callable API or only
a web portal is **not established** by public documentation — treat the
adapter's `vevo_check` capability as unverified until an account is created and
the surface inspected.

Agent authority over a client's matters is established with **Form 956**
(authorised recipient) or **956A** (registered migration agent) — a legal
prerequisite for acting on an applicant's behalf regardless of transport.

### What Meru should do next — in this order

1. **Register an organisation account on the developer portal** and enumerate
   which products are open-tier vs restricted. This costs nothing and is the
   only way to resolve the open questions above.
2. **Create an Organisation ImmiAccount** and determine whether VEVO exposes a
   machine interface or a portal only.
3. **Request restricted Visa/Case products** if step 1 shows the needed
   endpoints are gated. Expect assessment and follow-up questions.
4. Confirm the OMARA registration path for whichever entity will hold agent
   authority.

### One operational note for whoever does step 1

`developer.homeaffairs.gov.au` presented an **incomplete TLS certificate chain**
to a non-browser client during this research (`unable to verify the first
certificate`). Browsers paper over this using cached intermediates; server-side
HTTP clients do not. When the adapter is pointed at real endpoints it may need
the intermediate supplied explicitly. **Do not "fix" this by disabling
certificate verification** — that would defeat the point of mTLS on a
government integration.

---

## 3. Where this leaves the connector registry

The per-tenant connector registry (`GET/PUT /integrations/connectors`) already
models exactly what this research implies:

- `mode: 'sandbox' | 'live'` — a tenant stays in sandbox until credentials exist
- `credentials` — encrypted at rest, write-only over the API
- Live mode with `enabled: true` and no credentials is **rejected**

So the product can be sold, demonstrated and onboarded today with every
connector honestly badged SANDBOX, and each one flips to live independently as
its licensing lands. No code changes are needed for that transition — only
credentials.

The remaining honesty gap is in the UI: a sandbox connector must never render as
if it were returning real regulator data. That contract is already documented in
`MERU-FE-BE-HANDOFF.md` §5 for vessel risk (`live: false` + `unavailableReason`
means *unknown*, never *clear*) and the same discipline applies here.

---

## Sources

- CBUAE / Nebras Open Finance — https://www.pinsentmasons.com/out-law/guides/uae-open-finance
- CBUAE API Trust Framework — https://medium.com/@imeshuperera/inside-the-cbuaes-api-trust-framework-how-uae-is-securing-open-finance-c0fad30429f8
- CBUAE fintech update (Apr 2025) — https://mena-fintech.org/wp-content/uploads/2025/05/CBUAE-Report.pdf
- Home Affairs Developer Portal — https://developer.homeaffairs.gov.au/public/
- Home Affairs API products — https://developer.homeaffairs.gov.au/public/product
- Home Affairs "Using our APIs" — https://developer.homeaffairs.gov.au/public/node/3
- VEVO (check conditions online) — https://immi.homeaffairs.gov.au/visas/already-have-a-visa/check-visa-details-and-conditions/check-conditions-online
- VEVO organisation fact sheet — https://psplearninghub.com.au/wp-content/uploads/Department-of-Home-Affairs-Visa-Entitlement-Verification-Online-Tool-VEVO-fact-sheet.pdf
