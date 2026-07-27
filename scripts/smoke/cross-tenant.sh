#!/bin/bash
# The test that matters: two real tenants over HTTP, each with a valid token.
# Tenant A must not be able to see or touch tenant B's data by any route.
B=http://localhost:8000/api/v1
pass=0; fail=0
ok(){ printf "  PASS  %s\n" "$1"; pass=$((pass+1)); }
no(){ printf "  FAIL  %s — %s\n" "$1" "$2"; fail=$((fail+1)); }
jqid(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval('j'+process.argv[1])||'')}catch(e){console.log('')}})" "$1"; }

mktenant() { # slug-prefix -> "tenantId token"
  local slug="$1-$RANDOM" email="$1-$RANDOM@probe.test" pw="ProbePassw0rd!23"
  local s=$(curl -s -m 45 -X POST "$B/tenants/signup" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$1\",\"slug\":\"$slug\",\"vertical\":\"immigration\",\"firstName\":\"A\",\"lastName\":\"B\",\"email\":\"$email\",\"password\":\"$pw\"}")
  local tid=$(echo "$s" | jqid "?.data?.data?.tenant?.id")
  local l=$(curl -s -m 45 -X POST "$B/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$pw\"}")
  local tok=$(echo "$l" | jqid "?.data?.access_token")
  echo "$tid $tok"
}

echo "── Provisioning two tenants ───────────────────────────────"
read TA TOKA <<< "$(mktenant xt-alpha)"
read TB TOKB <<< "$(mktenant xt-bravo)"
[ -n "$TA" ] && [ -n "$TOKA" ] && ok "tenant A $TA" || no "tenant A" "signup/login failed"
[ -n "$TB" ] && [ -n "$TOKB" ] && ok "tenant B $TB" || no "tenant B" "signup/login failed"
[ -z "$TOKA" ] || [ -z "$TOKB" ] && { echo "cannot continue"; exit 1; }

echo
echo "── Each tenant writes one entity ──────────────────────────"
EA=$(curl -s -m 30 -X POST "$B/crm/entities" -H "Authorization: Bearer $TOKA" -H 'Content-Type: application/json' \
  -d '{"type":"person","firstName":"AlphaSecret","lastName":"X"}' | jqid "?.data?.data?.id || j?.data?.id")
EB=$(curl -s -m 30 -X POST "$B/crm/entities" -H "Authorization: Bearer $TOKB" -H 'Content-Type: application/json' \
  -d '{"type":"person","firstName":"BravoSecret","lastName":"Y"}' | jqid "?.data?.data?.id || j?.data?.id")
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
echo "══ $pass passed, $fail failed ══"
echo "CLEANUP=$TA $TB"
[ "$fail" -eq 0 ] || exit 1
