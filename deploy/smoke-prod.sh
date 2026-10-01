#!/usr/bin/env bash
# Production readiness smoke test for ReviewArena.
#
# Run this before every study session. It checks the things that silently
# ruin a session rather than loudly breaking it: a judge panel left off, a
# system that will be paired and then fail to generate, a backup that is not
# actually running, an admin API answering without a token.
#
# Everything here is READ-ONLY over HTTPS plus two local file checks. It
# uploads nothing, votes nothing and writes nothing, so it is safe to run
# against a live study in progress.
#
#   ./deploy/smoke-prod.sh                 # uses SITE_HOST + ADMIN_TOKEN from .env
#   SITE=example.org ./deploy/smoke-prod.sh
#
# Exit 0 = safe to start a session. Exit 1 = at least one FAIL.
#
# What it deliberately does NOT cover: an actual end-to-end upload → six
# reviews → three comparisons → vote → reveal pass. That costs provider
# budget and writes study rows, so it stays a manual step (see the note the
# script prints at the end).
set -uo pipefail

cd "$(dirname "$0")/.."

# ─── config ───────────────────────────────────────────────────────────────
[ -f .env ] || { echo "no .env at repo root"; exit 1; }
SITE="${SITE:-$(grep '^SITE_HOST=' .env | tail -1 | cut -d= -f2- | tr -d '"'"'"'')}"
TOKEN="${ADMIN_TOKEN:-$(grep '^ADMIN_TOKEN=' .env | tail -1 | cut -d= -f2- | tr -d '"'"'"'')}"
BASE="https://${SITE}"
API="${BASE}/api"

[ -n "$SITE" ]  || { echo "SITE_HOST not found in .env and \$SITE not set"; exit 1; }
[ -n "$TOKEN" ] || { echo "ADMIN_TOKEN not found in .env"; exit 1; }

FAILED=0
WARNED=0

pass() { printf '[ \033[32mok\033[0m   ] %-22s %s\n' "$1" "${2-}"; }
fail() { printf '[ \033[31mFAIL\033[0m ] %-22s %s\n' "$1" "${2-}"; FAILED=$((FAILED + 1)); }
warn() { printf '[ \033[33mWARN\033[0m ] %-22s %s\n' "$1" "${2-}"; WARNED=$((WARNED + 1)); }
hint() { printf '%29s → %s\n' "" "$1"; }

# Field extraction without jq (not installed on the VM). Node is always
# present — it is what the api runs on.
field() { node -e '
  let s = "";
  process.stdin.on("data", d => s += d).on("end", () => {
    try {
      let o = JSON.parse(s);
      for (const k of process.argv[1].split(".")) o = o?.[k];
      console.log(Array.isArray(o) ? o.join(",") : (o ?? ""));
    } catch { console.log(""); }
  });' "$1"; }

get()      { curl -sS --max-time 20 "$@"; }
status()   { curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$@"; }

echo "ReviewArena production smoke test — ${BASE}"
echo

# ─── 1. reachability and TLS ──────────────────────────────────────────────
# No -k anywhere: a cert that stopped renewing must fail this, not be waved
# through. Caddy renews on its own, but only while port 80 stays reachable.
if ! curl -sS --max-time 20 -o /dev/null "$API/health" 2>/dev/null; then
  fail "tls / reachability" "cannot complete a verified HTTPS request"
  hint "check Caddy is up and the cert renewed: docker compose -f docker-compose.prod.yml logs caddy"
else
  EXPIRY=$(echo | openssl s_client -servername "$SITE" -connect "$SITE:443" 2>/dev/null \
           | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -n "$EXPIRY" ]; then
    LEFT=$(( ( $(date -d "$EXPIRY" +%s) - $(date +%s) ) / 86400 ))
    if   [ "$LEFT" -lt 7 ];  then warn "tls" "cert expires in ${LEFT}d ($EXPIRY)"
    else pass "tls" "valid, ${LEFT}d remaining"; fi
  else
    pass "tls" "verified"
  fi
fi

# ─── 2. api health ────────────────────────────────────────────────────────
H=$(get "$API/health")
if [ "$(echo "$H" | field ok)" = "true" ] && [ "$(echo "$H" | field db)" = "ok" ]; then
  pass "api health" "ok, db reachable"
else
  fail "api health" "$H"
fi

# ─── 3. web app ───────────────────────────────────────────────────────────
WEB=$(status "$BASE/")
if [ "$WEB" = "200" ]; then pass "web app" "serving (200)"
else fail "web app" "GET / returned $WEB"; fi

# ─── 4. admin API refuses anonymous callers ───────────────────────────────
# router.use("/admin", guard) should make every admin route 401 without a
# bearer token. If this ever passes unauthenticated, the study data and the
# settings that shape it are world-writable.
ANON=$(status "$API/admin/settings")
if [ "$ANON" = "401" ] || [ "$ANON" = "403" ]; then
  pass "admin auth" "anonymous request rejected ($ANON)"
else
  fail "admin auth" "anonymous GET /admin/settings returned $ANON, expected 401"
  hint "ADMIN_TOKEN may be unset in the container — the guard cannot run without it"
fi

# ─── 5. judge panel ───────────────────────────────────────────────────────
# The failure this exists to catch: the panel left paused, the session run,
# and every study pair landing with judgeStatus=PENDING and no verdicts —
# discovered only when the human-vs-judge analysis has nothing to join on.
S=$(get -H "Authorization: Bearer $TOKEN" "$API/admin/settings")
JUDGE=$(echo "$S" | field judgeEnabled)
PANEL=$(echo "$S" | field panelSlugs)
PANEL_N=$(echo "$PANEL" | tr ',' '\n' | grep -c . || true)

if [ "$JUDGE" = "true" ]; then
  pass "judge panel" "enabled"
elif [ "$JUDGE" = "false" ]; then
  fail "judge panel" "PAUSED — study pairs will not be judged"
  hint "Admin → Settings → enable, then scripts/rescore-missing.ts to backfill anything already collected"
else
  fail "judge panel" "could not read /admin/settings (token wrong?)"
fi

if [ "$PANEL_N" = "6" ]; then pass "judge panel size" "6 members"
else warn "judge panel size" "$PANEL_N members, expected 6 ($PANEL)"; fi

# ─── 6. the study lineup ──────────────────────────────────────────────────
# seed-systems.sql enables all six unconditionally (SQL cannot read the
# environment), so the count matching is necessary but not sufficient —
# preflight --live is what proves the keys actually authenticate.
EXPECTED="claude-sonnet-5 deepseek-v4-flash gemini-3.8-flash glm-5.2 gpt-5.6-terra mistral-medium-3.5"
SYS=$(get "$API/review-systems" | field systems)
ENABLED=$(get "$API/review-systems" \
          | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
              try{console.log(JSON.parse(s).systems.map(x=>x.slug).sort().join(" "))}catch{console.log("")}})')

if [ "$ENABLED" = "$(echo $EXPECTED | tr " " "\n" | sort | tr "\n" " " | sed "s/ $//")" ]; then
  pass "study lineup" "exactly the 6 preregistered systems"
else
  fail "study lineup" "enabled set does not match rotation.ts"
  hint "got:      $ENABLED"
  hint "expected: $EXPECTED"
fi

case "$ENABLED" in
  *kimi*) fail "retired systems" "kimi-k3 is enabled — it left the lineup in 2026-09" ;;
  *)      pass "retired systems" "kimi-k3 absent" ;;
esac

# ─── 7. nothing but Caddy is exposed ──────────────────────────────────────
# Postgres and both app services are supposed to be compose-network only.
# A published port here would put the thesis dataset on the public internet.
#
# Probe the VM's PUBLIC IP, not $SITE: on the VM itself the hostname
# resolves to 127.0.1.1 via /etc/hosts, so every probe would hit loopback
# and a port published on 0.0.0.0 would read as "closed" — the exact
# misconfiguration this check exists to find.
#
# Run from the VM this tests the host's own filtering only. A port that
# reads OPEN here is genuinely bound to the public interface; whether the
# university's upstream firewall also blocks it is something only an
# off-campus probe can answer. Treat OPEN as "assume reachable".
PUBIP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^17[23]\.' | head -1)"
if [ -z "$PUBIP" ]; then
  warn "port exposure" "could not determine the public IP; skipped"
else
  for probe in "5432:postgres" "8080:review-gen/api" "15432:db-tunnel"; do
    PORT="${probe%%:*}"; WHAT="${probe##*:}"
    if timeout 5 bash -c "exec 3<>/dev/tcp/${PUBIP}/${PORT}" 2>/dev/null; then
      fail "exposed port" "${PORT} (${WHAT}) is bound on ${PUBIP}"
      hint "the DEV docker-compose.yml publishes 5432 as \"5432:5432\" — all interfaces."
      hint "bind it to loopback (\"127.0.0.1:5432:5432\") or stop the dev stack on this VM"
    else
      pass "closed port" "${PORT} (${WHAT}) not bound on ${PUBIP}"
    fi
  done
fi

# ─── 8. backups ───────────────────────────────────────────────────────────
# backup.sh calls the votes table irreplaceable. An uninstalled cron is the
# quiet version of having no backups at all.
if crontab -l 2>/dev/null | grep -q "backup.sh"; then
  pass "backup cron" "installed"
else
  fail "backup cron" "no crontab entry calling backup.sh"
  hint "crontab -e → 17 3 * * * cd $(pwd) && ./deploy/backup.sh >> ~/reviewarena-backup.log 2>&1"
fi

NEWEST=$(ls -t backups/*.dump 2>/dev/null | head -1)
if [ -z "$NEWEST" ]; then
  fail "backup freshness" "no dump in backups/"
else
  AGE=$(( ( $(date +%s) - $(date -r "$NEWEST" +%s) ) / 86400 ))
  SIZE=$(du -h "$NEWEST" | cut -f1)
  if   [ "$AGE" -gt 2 ]; then warn "backup freshness" "newest is ${AGE}d old ($NEWEST, $SIZE)"
  else pass "backup freshness" "${AGE}d old, $SIZE"; fi
fi

# ─── 9. current study state ───────────────────────────────────────────────
# Informational: printed so you can confirm the board matches what you
# expect before starting, and spot a session that was already run.
LB=$(get "$API/leaderboard")
printf '\n  papers: %s   votes: %s   ranked: %s   unranked: %s\n' \
  "$(echo "$LB" | field totalPapers)" \
  "$(echo "$LB" | field totalVotes)" \
  "$(echo "$LB" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).entries.length)}catch{console.log("?")}})')" \
  "$(echo "$LB" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).unranked.length)}catch{console.log("?")}})')"

# ─── verdict ──────────────────────────────────────────────────────────────
echo
if [ "$FAILED" -gt 0 ]; then
  printf '\033[31m%d FAILED\033[0m, %d warning(s). Do not start a session.\n' "$FAILED" "$WARNED"
else
  printf '\033[32mAll checks passed\033[0m, %d warning(s).\n' "$WARNED"
fi

cat <<'NOTE'

Not covered here, still do both by hand before the first participant:
  1. preflight --live   — auth-checks all six provider keys for real.
     A key that is present but dead passes every check above and then
     fails mid-session, because seed-systems.sql enables all six blind.
  2. One full pass with a real participant code: upload -> 6 reviews ->
     3 comparisons -> vote -> reveal. Then confirm judge_verdicts gained
     rows; that is the only proof the panel actually ran.
NOTE

[ "$FAILED" -eq 0 ]
