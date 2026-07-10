#!/usr/bin/env bash
set -euo pipefail

# Install the launchd plist for the Go backend job `com.feedoverflow.app`.
# This script does not bootstrap or start the service; deploy.sh does that after
# building the binary and client. Run this once before the first deploy.
#
# Usage: scripts/install-service.sh          # PORT 3002, LOCAL_API_PORT 4002
#        PORT=8080 scripts/install-service.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

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

echo "OK: service plist installed; the service has not been started"
echo "    run scripts/deploy.sh to build and start FeedOverflow"
