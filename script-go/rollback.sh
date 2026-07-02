#!/usr/bin/env bash
set -euo pipefail

# Roll the launchd job back to the Node backend, restoring the plist saved by
# script-go/deploy.sh on its first run. The Node tree under
# ~/Deploy/rss-reader/server is left in place by deploy.sh, so this is a clean flip.
#
# Usage: script-go/rollback.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

LABEL="com.rss-reader.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BAK="$PLIST.node.bak"
PORT="${PORT:-3002}"

[ -f "$BAK" ] || { echo "error: no $BAK to restore (was deploy.sh ever run?)"; exit 1; }

echo "==> restore Node plist"
cp "$BAK" "$PLIST"

echo "==> reload launchd service"
reload_service "$LABEL" "$PLIST"

echo "==> health check (public :$PORT)"
sleep 2
for _ in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$PORT/api/auth-check" >/dev/null 2>&1; then
    echo "OK: rolled back to Node on :$PORT"
    exit 0
  fi
  sleep 0.5
done
echo "!! Node health check failed after rollback — inspect $HOME/Deploy/rss-reader/logs/server.log"
exit 1
