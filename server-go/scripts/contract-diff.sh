#!/usr/bin/env bash
# Contract-diff harness (docs/plan-go-backend-migration.md Phase 3/11): stands up
# the real Node server and the Go build against an identical frozen copy of the
# DB and asserts every read endpoint returns byte-identical JSON.
#
# How it stays deterministic:
#   - .backup gives a consistent snapshot (includes committed WAL, unlike cp).
#   - cmd/freezefeeds stamps every feed fresh so Node's ensureFresh never hits the
#     network (which would mutate node.db mid-run). Node runs under TEST_DB so the
#     poller / cache-warming stay off; we query its no-auth loopback listener.
#   - Normalization: /api/feeds drops the dead `category` column (Go omits it by
#     design, see db.go); all-articles/today drop the transient `cacheReady` flag.
#
# Usage: [SRC_DB=/path/to/rss.db] server-go/scripts/contract-diff.sh
set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_DB="${SRC_DB:-$HOME/Deploy/rss-reader/server/rss.db}"
WORK="${WORK:-/tmp/rss-parity/cdiff}"
NODE_PORT=4991   # Node no-auth loopback listener (LOCAL_API_PORT)
NODE_PUB=3991    # Node public listener (unused, kept off production ports)
GO_PORT=4912     # Go no-auth loopback listener (LOCAL_API_PORT)
GO_PUB=3912      # Go public listener (unused here)
NODE_URL="http://127.0.0.1:$NODE_PORT"
GO_URL="http://127.0.0.1:$GO_PORT"

command -v sqlite3 >/dev/null || { echo "sqlite3 required"; exit 1; }

rm -rf "$WORK"; mkdir -p "$WORK"
sqlite3 "$SRC_DB" ".backup '$WORK/base.db'"
( cd "$REPO/server-go" && CGO_ENABLED=1 go run ./cmd/freezefeeds "$WORK/base.db" ) || exit 1
cp "$WORK/base.db" "$WORK/node.db"
cp "$WORK/base.db" "$WORK/go.db"
( cd "$REPO/server-go" && CGO_ENABLED=1 go build -o "$WORK/server-go" . ) || { echo "go build failed"; exit 1; }

# Free the test ports from any zombie of a prior run (only these ports; production
# on 3002/4002 is never touched).
for p in $NODE_PORT $NODE_PUB $GO_PORT $GO_PUB; do
  lsof -ti tcp:$p 2>/dev/null | xargs -r kill 2>/dev/null
done
sleep 0.3

( cd "$REPO/server" && TEST_DB="$WORK/node.db" PORT=$NODE_PUB LOCAL_API_PORT=$NODE_PORT \
    exec node index.ts >"$WORK/node.log" 2>&1 ) &
NODE_PID=$!
RSS_DB="$WORK/go.db" PORT=$GO_PUB LOCAL_API_PORT=$GO_PORT "$WORK/server-go" >"$WORK/go.log" 2>&1 &
GO_PID=$!
cleanup() { kill $NODE_PID $GO_PID 2>/dev/null; }
trap cleanup EXIT

for i in $(seq 1 50); do
  curl -sf "$GO_URL/healthz" >/dev/null 2>&1 && \
  curl -sf "$NODE_URL/api/settings" >/dev/null 2>&1 && break
  sleep 0.2
done

AID=$(sqlite3 "$WORK/base.db" "SELECT article_id FROM article_states LIMIT 1")
FID=$(sqlite3 "$WORK/base.db" "SELECT id FROM feeds LIMIT 1")

declare -a ENDPOINTS=(
  "/api/feeds|map(del(.category))"
  "/api/feeds/$FID/articles|."
  "/api/all-articles|del(.cacheReady)"
  "/api/all-articles?mode=digest|del(.cacheReady)"
  "/api/today|del(.cacheReady)"
  "/api/today?mode=digest|del(.cacheReady)"
  "/api/starred|."
  "/api/podcasts|."
  "/api/starred/count|."
  "/api/settings|."
  "/api/articles/$AID/content|."
)

FAIL=0
for spec in "${ENDPOINTS[@]}"; do
  ep="${spec%%|*}"; norm="${spec#*|}"
  n=$(curl -s "$NODE_URL$ep" | jq -S "$norm" 2>/dev/null)
  g=$(curl -s "$GO_URL$ep"   | jq -S "$norm" 2>/dev/null)
  if [ -n "$n" ] && [ "$n" == "$g" ]; then
    echo "OK    $ep"
  else
    echo "DIFF  $ep"
    diff <(echo "$n") <(echo "$g") | head -30
    FAIL=1
  fi
done
exit $FAIL
