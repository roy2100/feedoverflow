#!/usr/bin/env bash
set -euo pipefail

# Roll out a new build of the PUBLIC DEMO instance into ~/Deploy/rss-demo:
# build the client with the demo banner (VITE_DEMO_MODE=1), build the cgo binary,
# sync both in, and kickstart the demo launchd service.
#
# Mirrors deploy.sh but targets the demo root/label/ports. The launchd services
# must already be registered by install-demo-service.sh; this never writes plists.
#
# Usage: scripts/demo-deploy.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=demo-lib.sh
source "$SCRIPT_DIR/demo-lib.sh"

DEV_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

mkdir -p "$DEMO_DIST" "$DEMO_DATA" "$DEMO_LOGS" "$(dirname "$DEMO_ENV")"

echo "==> build client (VITE_DEMO_MODE=1)"
npm install --prefix "$DEV_ROOT/client" --legacy-peer-deps
VITE_DEMO_MODE=1 npm run --prefix "$DEV_ROOT/client" build
rsync -a --delete "$DEV_ROOT/client/dist/" "$DEMO_DIST/"

echo "==> build go binary (CGO_ENABLED=1, arm64)"
( cd "$DEV_ROOT/server-go" && CGO_ENABLED=1 go build -o "$DEMO_BIN" . )
echo "    $(ls -la "$DEMO_BIN" | awk '{print $5" bytes"}')"

[ -f "$DEMO_PLIST" ] || {
  echo "error: demo service not installed ($DEMO_PLIST missing)"
  echo "       binary is built — run scripts/install-demo-service.sh to register it"
  exit 1
}

echo "==> kickstart demo launchd service"
kickstart_service "$DEMO_LABEL"

echo "==> health check (loopback :$DEMO_LOCAL_API_PORT)"
if health_check "http://127.0.0.1:$DEMO_LOCAL_API_PORT/healthz"; then
  echo "OK: demo live on :$DEMO_PORT (loopback :$DEMO_LOCAL_API_PORT)"
  echo "    logs: $DEMO_LOGS/app.log (NDJSON)"
  exit 0
fi
echo "!! HEALTH CHECK FAILED — inspect $DEMO_LOGS/server.log"
exit 1
