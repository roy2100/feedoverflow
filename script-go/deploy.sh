#!/usr/bin/env bash
set -euo pipefail

# Roll out a new Go-backend build: build the client, build the cgo Go binary on the
# Mac (no cross-compile), sync both into ~/Deploy/rss-reader, and kickstart the
# installed launchd service so the new binary/client take effect.
#
# The launchd service must already be registered by script-go/install-service.sh —
# deploy.sh never writes the plist. On a fresh box, run deploy.sh once (it builds the
# binary, then tells you to install the service), then install-service.sh.
#
# Usage: script-go/deploy.sh            # PORT 3002, LOCAL_API_PORT 4002
#        PORT=8080 script-go/deploy.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

DEV_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

[ -d "$DEPLOY_ROOT" ] || { echo "error: $DEPLOY_ROOT missing"; exit 1; }

echo "==> build client"
npm install --prefix "$DEV_ROOT/client" --legacy-peer-deps
npm run --prefix "$DEV_ROOT/client" build
rsync -a --delete "$DEV_ROOT/client/dist/" "$DEPLOY_ROOT/client/dist/"

echo "==> build go binary (CGO_ENABLED=1, arm64)"
( cd "$DEV_ROOT/server-go" && CGO_ENABLED=1 go build -o "$BIN" . )
echo "    $(ls -la "$BIN" | awk '{print $5" bytes"}')"

[ -f "$PLIST" ] || {
  echo "error: service not installed ($PLIST missing)"
  echo "       binary is built — run script-go/install-service.sh to register it"
  exit 1
}

echo "==> kickstart launchd service"
kickstart_service "$LABEL"

echo "==> health check (loopback :$LOCAL_API_PORT)"
if health_check "http://127.0.0.1:$LOCAL_API_PORT/healthz"; then
  echo "OK: Go backend live on :$PORT (loopback :$LOCAL_API_PORT)"
  echo "    logs: $DEPLOY_ROOT/logs/app.log (NDJSON)"
  exit 0
fi
echo "!! HEALTH CHECK FAILED — inspect $DEPLOY_ROOT/logs/server.log"
exit 1
