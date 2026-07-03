#!/usr/bin/env bash
set -euo pipefail

# Register the Go backend as the launchd job `com.rss-reader.app`: write the
# LaunchAgent plist pointing at the deployed binary, bootstrap it, and health-check.
# Run this once on a fresh box (after deploy.sh has built the binary); thereafter
# deploy.sh alone rolls out new builds by kickstarting the installed service.
#
# Usage: scripts/install-service.sh          # PORT 3002, LOCAL_API_PORT 4002
#        PORT=8080 scripts/install-service.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

[ -x "$BIN" ] || {
  echo "error: binary not found at $BIN"
  echo "       run scripts/deploy.sh first to build it, then re-run this script"
  exit 1
}

echo "==> write launchd plist → $BIN"
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

echo "==> bootstrap launchd service"
reload_service "$LABEL" "$PLIST"

echo "==> health check (loopback :$LOCAL_API_PORT)"
if health_check "http://127.0.0.1:$LOCAL_API_PORT/healthz"; then
  echo "OK: service installed, Go backend live on :$PORT (loopback :$LOCAL_API_PORT)"
  echo "    logs: $DEPLOY_ROOT/logs/app.log (NDJSON)"
  exit 0
fi
echo "!! HEALTH CHECK FAILED — inspect $DEPLOY_ROOT/logs/server.log"
exit 1
