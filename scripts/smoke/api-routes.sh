#!/bin/bash
# Smoke-tests the API surface. Unauthenticated calls to protected routes MUST
# return 401 — a 200 there would mean the guard is missing, and a 500 would mean
# the route throws before auth. Both are failures worth catching.
#
# Usage:  ./scripts/smoke/api-routes.sh                     # local
#         BASE_URL=https://meru-core.vercel.app  ...        # deployed
ORIGIN=${BASE_URL:-http://localhost:8000}
B="$ORIGIN/api/v1"
pass=0; fail=0
echo "Target: $ORIGIN"
echo

check() { # name method path expected_csv [data]
  local name="$1" method="$2" path="$3" expect="$4" data="$5"
  local code
  if [ -n "$data" ]; then
    code=$(curl -s -o /dev/null -m 20 -w "%{http_code}" -X "$method" "$B$path" \
      -H 'Content-Type: application/json' -d "$data")
  else
    code=$(curl -s -o /dev/null -m 20 -w "%{http_code}" -X "$method" "$B$path")
  fi
  if echo ",$expect," | grep -q ",$code,"; then
    printf "  PASS  %-6s %-42s %s\n" "$method" "$path" "$code"; pass=$((pass+1))
  else
    printf "  FAIL  %-6s %-42s got %s want %s\n" "$method" "$path" "$code" "$expect"; fail=$((fail+1))
  fi
}

checkAbs() { # name method absolute_path expected_csv
  local name="$1" method="$2" path="$3" expect="$4" code
  code=$(curl -s -o /dev/null -m 20 -w "%{http_code}" -X "$method" "$ORIGIN$path")
  if echo ",$expect," | grep -q ",$code,"; then
    printf "  PASS  %-6s %-42s %s\n" "$method" "$path" "$code"; pass=$((pass+1))
  else
    printf "  FAIL  %-6s %-42s got %s want %s\n" "$method" "$path" "$code" "$expect"; fail=$((fail+1))
  fi
}

echo "── Public / infrastructure ────────────────────────────────"
check health   GET  /health                    200
check root     GET  /                          200
checkAbs swagger    GET /api      200,301,304
checkAbs swaggerjson GET /api-json 200

echo
echo "── Auth surface (validation + guards) ─────────────────────"
check login-empty    POST /auth/login    400,401 '{}'
check login-bad      POST /auth/login    400,401 '{"email":"nobody@example.com","password":"wrong"}'
check register-empty POST /auth/register 400 '{}'
check refresh-empty  POST /auth/refresh  400,401 '{}'
check profile-noauth GET  /auth/profile  401

echo
echo "── Protected routes must reject anonymous callers (401) ───"
for p in /crm/entities /documents /tasks /forms /workflows /notifications \
         /billing/plans /analytics/reports /audit/logs /storage/files \
         /queue/jobs /queue/metrics /search /ai/prompts /elasticsearch/indices \
         /tenants/1/stats /integrations/adapters /config-packs; do
  check guard GET "$p" 401,403
done

# config-packs used to have no guard at all — these mutating routes were
# reachable unauthenticated. Assert the whole surface is closed, not just GET.
check cfg-create POST   /config-packs   401,403 '{"code":"probe"}'
check cfg-delete DELETE /config-packs/1 401,403

echo
echo "── Tenant signup (public by design) ───────────────────────"
check check-slug POST /tenants/check-slug 200,201 '{"slug":"probe-does-not-exist"}'

echo
echo "── Cron routes require CRON_SECRET ────────────────────────"
check cron-sla     POST /jobs/sla-watchdog  401,403
check cron-billing POST /jobs/daily-billing 401,403
# Vercel Cron issues GET only, so the GET variants must exist AND be guarded.
check cron-sla-get GET  /jobs/sla-watchdog  401,403
check cron-tick    GET  /jobs/tick          401,403
check cron-drain   GET  /jobs/queue-drain   401,403

echo
echo "── Unknown route should 404, not 500 ──────────────────────"
check notfound GET /definitely-not-a-route 404

echo
echo "══ $pass passed, $fail failed ══"
[ "$fail" -eq 0 ] || exit 1
