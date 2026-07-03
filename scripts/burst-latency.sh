#!/usr/bin/env bash
set -euo pipefail

# Concurrent-burst latency smoke test for the article-list endpoints.
#
# Reproduces the "open a cross-feed view (today/all-articles) after idle" scenario that used to
# stall every concurrent request ~800ms: the read endpoints call ensureFresh across every feed,
# so a fan-out of stale feeds fired N on-demand refreshes whose synchronous RSS parse + persist
# blocked the single Node thread, and every concurrent request queued behind them. The fix
# (single-flight dedup + a refresh concurrency cap in cache.ts) keeps that work from bunching.
#
# This fires the browser-like burst of requests concurrently and prints each endpoint's total
# time. The regression signature is a trivial request (starred/count) getting dragged up to the
# list-endpoint latency — under the fix everything stays low (tens of ms) even with stale feeds.
#
# Targets the loopback no-auth API (LOCAL_API_PORT, default 4002) so it needs no session cookie.
# Override BASE_URL to hit another listener (the auth-gated public app / Caddy will 401 without a
# cookie, so timings there measure the reject path, not the real handler).
#
# Usage:
#   ./scripts/burst-latency.sh                              # 3 rounds against 127.0.0.1:4002
#   ROUNDS=5 ./scripts/burst-latency.sh
#   BASE_URL=http://127.0.0.1:3002 ./scripts/burst-latency.sh
#   FAIL_MS=300 ./scripts/burst-latency.sh                  # exit 1 if any request exceeds 300ms
#
# Tip: to reproduce the stale-feed condition, run it immediately after a restart
# (`launchctl kickstart -k "gui/$(id -u)/com.rss-reader.app"`) while startup warming is still in
# flight — that is when the old code stalled.

BASE_URL="${BASE_URL:-http://127.0.0.1:4002}"
ROUNDS="${ROUNDS:-3}"
FAIL_MS="${FAIL_MS:-0}"            # 0 = report only; >0 = fail the run if any request exceeds it

ENDPOINTS=(
  "api/starred/count"
  "api/feeds"
  "api/today?mode=digest"
  "api/all-articles?mode=digest"
)

echo "==> burst latency: $BASE_URL  (rounds=$ROUNDS, endpoints=${#ENDPOINTS[@]})"
[ "$FAIL_MS" -gt 0 ] && echo "    threshold: fail if any request > ${FAIL_MS}ms"

# Wait for the server to answer before measuring (survives a just-restarted service).
for _ in $(seq 1 20); do
  curl -fsS -o /dev/null "$BASE_URL/api/feeds" 2>/dev/null && break
  sleep 0.5
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
worst_ms=0
fail=0

# Warm-up (discarded): the very first request after the process has been idle pays a one-off
# wake-up cost (macOS compresses idle pages; unrelated to the refresh path). It also primes each
# endpoint's keep-alive connection so the measured requests below reuse it instead of paying
# fresh-connection setup. Measure steady state so FAIL_MS gates the concurrent-refresh behavior.
for ep in "${ENDPOINTS[@]}"; do curl -sk --keepalive -o /dev/null "$BASE_URL/$ep" & done
wait

# Fire each endpoint on its own persistent keep-alive connection, reused across all ROUNDS
# requests, with the four endpoints running concurrently. Reusing one connection per endpoint
# matches the real client path (browser -> Caddy -> rathole -> Node all hold persistent
# connections). A fresh connection per request instead occasionally stalls ~600ms waiting on the
# server's accept queue under connection churn — a load-generator artifact, not an event-loop
# stall, so it must not pollute this measurement. ROUNDS = requests per endpoint.
i=0
for ep in "${ENDPOINTS[@]}"; do
  {
    for _ in $(seq 1 "$ROUNDS"); do
      printf 'url = "%s/%s"\n-o /dev/null\n-w "%%{time_total}\\n"\n' "$BASE_URL" "$ep"
    done | curl -sk --keepalive -K - >"$tmp/$i"
  } &
  i=$((i + 1))
done
wait

# The endpoints ran concurrently, so the r-th sample of each lines up in time — transpose the
# per-endpoint sample lists back into per-round rows for display.
for round in $(seq 1 "$ROUNDS"); do
  echo "--- burst $round (concurrent, keep-alive) ---"
  i=0
  for ep in "${ENDPOINTS[@]}"; do
    sec="$(awk "NR==$round" "$tmp/$i")"
    ms="$(awk "BEGIN{printf \"%.0f\", ${sec:-0} * 1000}")"
    printf "  %-32s %5dms\n" "$ep" "$ms"
    [ "$ms" -gt "$worst_ms" ] && worst_ms="$ms"
    { [ "$FAIL_MS" -gt 0 ] && [ "$ms" -gt "$FAIL_MS" ]; } && fail=1
    i=$((i + 1))
  done
done

echo "==> worst: ${worst_ms}ms"
if [ "$fail" -ne 0 ]; then
  echo "FAIL: a request exceeded ${FAIL_MS}ms — event-loop stall regression?"
  exit 1
fi
