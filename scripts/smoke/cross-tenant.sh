#!/bin/bash
# The test that matters: two real tenants over HTTP, each with a valid token.
# Tenant A must not be able to see or touch tenant B's data by any route.
#
# Usage:  ./scripts/smoke/cross-tenant.sh                    # local
#         BASE_URL=https://meru-core.vercel.app  ...         # deployed
B="${BASE_URL:-http://localhost:8000}/api/v1"
pass=0; fail=0
echo "Target: $B"
ok(){ printf "  PASS  %s\n" "$1"; pass=$((pass+1)); }
no(){ printf "  FAIL  %s — %s\n" "$1" "$2"; fail=$((fail+1)); }
jqid(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval('j'+process.argv[1])||'')}catch(e){console.log('')}})" "$1"; }

mktenant() { # slug-prefix -> "tenantId token slug"
  local slug="$1-$RANDOM" email="$1-$RANDOM@probe.test" pw="ProbePassw0rd!23"
  local s=$(curl -s -m 45 -X POST "$B/tenants/signup" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$1\",\"slug\":\"$slug\",\"vertical\":\"immigration\",\"firstName\":\"A\",\"lastName\":\"B\",\"email\":\"$email\",\"password\":\"$pw\"}")
  # Single envelope: `{ data: { tenant, user, ... } }`. This used to read
  # `data.data.tenant.id` because the handler self-wrapped in `{success,data}`
  # and the interceptor then wrapped that again. That double envelope is gone.
  local tid=$(echo "$s" | jqid "?.data?.tenant?.id")
  local l=$(curl -s -m 45 -X POST "$B/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$pw\"}")
  local tok=$(echo "$l" | jqid "?.data?.access_token")
  echo "$tid $tok $slug"
}

echo "── Provisioning two tenants ───────────────────────────────"
read TA TOKA SLUGA <<< "$(mktenant xt-alpha)"
read TB TOKB SLUGB <<< "$(mktenant xt-bravo)"
[ -n "$TA" ] && [ -n "$TOKA" ] && ok "tenant A $TA" || no "tenant A" "signup/login failed"
[ -n "$TB" ] && [ -n "$TOKB" ] && ok "tenant B $TB" || no "tenant B" "signup/login failed"
[ -z "$TOKA" ] || [ -z "$TOKB" ] && { echo "cannot continue"; exit 1; }

echo
echo "── Each tenant writes one entity ──────────────────────────"
EA=$(curl -s -m 30 -X POST "$B/crm/entities" -H "Authorization: Bearer $TOKA" -H 'Content-Type: application/json' \
  -d '{"type":"person","firstName":"AlphaSecret","lastName":"X"}' | jqid "?.data?.id")
EB=$(curl -s -m 30 -X POST "$B/crm/entities" -H "Authorization: Bearer $TOKB" -H 'Content-Type: application/json' \
  -d '{"type":"person","firstName":"BravoSecret","lastName":"Y"}' | jqid "?.data?.id")
[ -n "$EA" ] && ok "A wrote entity" || no "A write" "no id"
[ -n "$EB" ] && ok "B wrote entity" || no "B write" "no id"

echo
echo "── Listing must not leak across tenants ───────────────────"
LA=$(curl -s -m 30 -H "Authorization: Bearer $TOKA" "$B/crm/entities")
LB=$(curl -s -m 30 -H "Authorization: Bearer $TOKB" "$B/crm/entities")
echo "$LA" | grep -q AlphaSecret && ok "A sees its own row" || no "A self-read" "missing"
echo "$LA" | grep -q BravoSecret && no "A LEAKED B's row" "cross-tenant read" || ok "A cannot see B's row"
echo "$LB" | grep -q BravoSecret && ok "B sees its own row" || no "B self-read" "missing"
echo "$LB" | grep -q AlphaSecret && no "B LEAKED A's row" "cross-tenant read" || ok "B cannot see A's row"

echo
echo "── Direct fetch of another tenant's entity by id ──────────"
code=$(curl -s -o /dev/null -m 30 -w "%{http_code}" -H "Authorization: Bearer $TOKA" "$B/crm/entities/$EB")
[ "$code" = "404" ] || [ "$code" = "403" ] && ok "A fetching B's entity -> $code" || no "direct fetch" "got $code (expected 404/403)"

echo
echo "── Another tenant's stats ─────────────────────────────────"
SB=$(curl -s -m 30 -H "Authorization: Bearer $TOKA" "$B/tenants/$TB/stats")
echo "$SB" | grep -q '"users":0\|MER-' && ok "A reading B's stats yields nothing/denied" || no "stats leak" "$(echo $SB | head -c 200)"

echo
echo "── Intra-tenant: one client must not see another's document ──"
# RLS isolates tenants, not users inside one (CLAUDE.md §5.1). This block used
# to mint two low-privilege same-tenant users via POST /auth/register to prove
# DocumentAccessService scopes each to their own uploads.
#
# POST /auth/register was removed 2026-09-04 (see iam.controller.ts): it ran
# its INSERT outside the runAsSystem bypass that wrapped its two reads, so on
# an unbound connection it 500'd the RLS WITH CHECK for every caller — and
# fixing that scoping bug alone would have shipped a worse one, since the
# route was @Public(), took only an anonymously-enumerable tenant slug
# (POST /tenants/check-slug has no guard), and let a caller self-provision
# into ANY existing tenant with no invite and no role gate. No product app has
# ever called it. There is currently no supported HTTP path that hands a
# freshly created low-privilege user a working session without email
# delivery (RESEND_API_KEY is unset in this environment), so this block can no
# longer run end-to-end over HTTP.
#
# The scoping logic itself is still covered at the unit level —
# src/documents/document-access.service.spec.ts — this is a loss of live HTTP
# confirmation, not a loss of test coverage for DocumentAccessService. Restore
# this block once an audited, operator-only "set initial password" path exists
# (see AGENTS.md / the register-removal note) or once invite email is wired up
# end-to-end so accept-invite can stand in for register here.
printf "  SKIP  intra-tenant document isolation — no HTTP path creates a usable low-privilege user without POST /auth/register (removed) or working invite email\n"

echo
echo "══ $pass passed, $fail failed ══"
echo "CLEANUP=$TA $TB"
[ "$fail" -eq 0 ] || exit 1
