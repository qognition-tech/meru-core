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
# RLS isolates tenants, not users inside one (CLAUDE.md §5.1). Two self-
# registered users in tenant A hold no staff role, so DocumentAccessService
# scopes each to their own uploads. If storage is unconfigured the upload
# fails and this block reports SKIP — never a pass it did not earn.
mkuser() { # tenantSlug -> token
  local email="$1-user-$RANDOM@probe.test" pw="ProbePassw0rd!23"
  curl -s -m 30 -X POST "$B/auth/register" -H 'Content-Type: application/json' \
    -d "{\"tenantSlug\":\"$2\",\"email\":\"$email\",\"password\":\"$pw\",\"firstName\":\"C\",\"lastName\":\"D\"}" >/dev/null
  curl -s -m 30 -X POST "$B/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$pw\"}" | jqid "?.data?.access_token"
}
if [ -z "$SLUGA" ]; then
  printf "  SKIP  intra-tenant — tenant A slug unknown\n"
else
  TOKC1=$(mkuser c1 "$SLUGA"); TOKC2=$(mkuser c2 "$SLUGA")
  if [ -z "$TOKC1" ] || [ -z "$TOKC2" ]; then
    no "intra-tenant users" "register/login failed for tenant $SLUGA"
  else
    TMPF=$(mktemp); printf 'AlphaClientSecret' > "$TMPF"
    UP=$(curl -s -m 45 -X POST "$B/documents/upload" -H "Authorization: Bearer $TOKC1" \
      -F "file=@$TMPF;filename=secret.txt;type=text/plain" -F "name=ClientOneSecret")
    rm -f "$TMPF"
    DID=$(echo "$UP" | jqid "?.data?.id")
    if [ -z "$DID" ]; then
      printf "  SKIP  intra-tenant document — upload failed (storage unconfigured?): %s\n" "$(echo "$UP" | head -c 160)"
    else
      ok "client 1 uploaded document $DID"
      code=$(curl -s -o /dev/null -m 30 -w "%{http_code}" -H "Authorization: Bearer $TOKC2" "$B/documents/$DID")
      [ "$code" = "404" ] && ok "client 2 fetching client 1's document -> 404" || no "intra-tenant direct fetch" "got $code (expected 404, never 403 — the id must not be confirmed)"
      code=$(curl -s -o /dev/null -m 30 -w "%{http_code}" -H "Authorization: Bearer $TOKC1" "$B/documents/$DID")
      [ "$code" = "200" ] && ok "client 1 reads own document" || no "own read" "got $code"
      code=$(curl -s -o /dev/null -m 30 -w "%{http_code}" -H "Authorization: Bearer $TOKA" "$B/documents/$DID")
      [ "$code" = "200" ] && ok "firm admin reads the client's document" || no "staff read" "got $code"
      L2=$(curl -s -m 30 -H "Authorization: Bearer $TOKC2" "$B/documents")
      echo "$L2" | grep -q "$DID" && no "client 2 LISTED client 1's document" "intra-tenant leak" || ok "client 2's list omits client 1's document"
      code=$(curl -s -o /dev/null -m 30 -w "%{http_code}" -X DELETE -H "Authorization: Bearer $TOKC2" "$B/documents/$DID")
      [ "$code" = "404" ] && ok "client 2 deleting client 1's document -> 404" || no "intra-tenant delete" "got $code"
    fi
  fi
fi

echo
echo "══ $pass passed, $fail failed ══"
echo "CLEANUP=$TA $TB"
[ "$fail" -eq 0 ] || exit 1
