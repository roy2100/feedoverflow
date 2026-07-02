#!/usr/bin/env bash
set -euo pipefail

# Go-backend deploy (Phase 12 cutover).
#
# Builds the client, builds the cgo Go binary on the Mac (no cross-compile), syncs
# both into ~/Deploy/rss-reader, points the launchd job at the Go binary, and
# reloads. The Node tree under ~/Deploy/rss-reader/server is left untouched so
# ./rollback.sh can flip straight back. The first run saves the current (Node)
# plist as <plist>.node.bak.
#
# Usage: script-go/deploy.sh            # PORT 3002, LOCAL_API_PORT 4002
#        PORT=8080 script-go/deploy.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

DEV_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_ROOT="$HOME/Deploy/rss-reader"
LABEL="com.rss-reader.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-3002}"
LOCAL_API_PORT="${LOCAL_API_PORT:-4002}"
BIN="$DEPLOY_ROOT/server-go"

[ -d "$DEPLOY_ROOT" ] || { echo "error: $DEPLOY_ROOT missing (run the Node migrate first)"; exit 1; }

echo "==> build client"
npm install --prefix "$DEV_ROOT/client" --legacy-peer-deps
npm run --prefix "$DEV_ROOT/client" build
rsync -a --delete "$DEV_ROOT/client/dist/" "$DEPLOY_ROOT/client/dist/"

echo "==> build go binary (CGO_ENABLED=1, arm64)"
( cd "$DEV_ROOT/server-go" && CGO_ENABLED=1 go build -o "$BIN" . )
echo "    $(ls -la "$BIN" | awk '{print $5" bytes"}')"

echo "==> back up existing plist (once)"
if [ -f "$PLIST" ] && [ ! -f "$PLIST.node.bak" ]; then
  cp "$PLIST" "$PLIST.node.bak"
  echo "    saved $PLIST.node.bak"
fi

echo "==> write launchd plist → Go binary"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$BIN</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>PORT</key>
		<string>$PORT</string>
		<key>LOCAL_API_PORT</key>
		<string>$LOCAL_API_PORT</string>
		<key>RSS_DB</key>
		<string>$DEPLOY_ROOT/server/rss.db</string>
		<key>CLIENT_DIST</key>
		<string>$DEPLOY_ROOT/client/dist</string>
		<key>LOG_DIR</key>
		<string>$DEPLOY_ROOT/logs</string>
		<key>RSS_ENV_FILE</key>
		<string>$DEPLOY_ROOT/server/.env</string>
	</dict>
	<key>WorkingDirectory</key>
	<string>$DEPLOY_ROOT</string>
	<key>KeepAlive</key>
	<true/>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardErrorPath</key>
	<string>$DEPLOY_ROOT/logs/server.log</string>
	<key>StandardOutPath</key>
	<string>$DEPLOY_ROOT/logs/server.log</string>
</dict>
</plist>
PLISTEOF

echo "==> reload launchd service"
reload_service "$LABEL" "$PLIST"

echo "==> health check (loopback :$LOCAL_API_PORT)"
sleep 2
for _ in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$LOCAL_API_PORT/healthz" >/dev/null 2>&1; then
    echo "OK: Go backend live on :$PORT (loopback :$LOCAL_API_PORT)"
    echo "    logs: $DEPLOY_ROOT/logs/app.log (NDJSON)"
    echo "    rollback: script-go/rollback.sh"
    exit 0
  fi
  sleep 0.5
done
echo "!! HEALTH CHECK FAILED — run script-go/rollback.sh to restore Node"
exit 1
