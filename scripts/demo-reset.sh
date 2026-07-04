#!/usr/bin/env bash
set -euo pipefail

# Restore the demo DB from its snapshot. Invoked by the com.rss-reader.demo-reset
# launchd timer every RESET_INTERVAL (6h), and safe to run by hand.
#
# Stops the demo app (so SQLite isn't mid-write), copies the seed over the live
# DB, drops stale WAL/SHM sidecars, restarts, and health-checks. Any feeds/stars
# a visitor added since the last reset are wiped.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=demo-lib.sh
source "$SCRIPT_DIR/demo-lib.sh"

log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"; }

[ -f "$DEMO_SEED" ] || {
  log "error: seed DB missing at $DEMO_SEED — build it first (seed/README.md); skipping reset"
  exit 1
}

uid="$(id -u)"
log "reset: stopping $DEMO_LABEL"
launchctl bootout "gui/$uid/$DEMO_LABEL" 2>/dev/null || true
for _ in $(seq 1 20); do
  launchctl print "gui/$uid/$DEMO_LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done

log "reset: restoring $DEMO_DB from snapshot"
cp -f "$DEMO_SEED" "$DEMO_DB"
rm -f "$DEMO_DB-wal" "$DEMO_DB-shm"

log "reset: restarting $DEMO_LABEL"
reload_service "$DEMO_LABEL" "$DEMO_PLIST"

if health_check "http://127.0.0.1:$DEMO_LOCAL_API_PORT/healthz"; then
  log "reset: OK — demo healthy on :$DEMO_PORT"
  exit 0
fi
log "reset: !! demo unhealthy after restart — inspect $DEMO_LOGS/server.log"
exit 1
