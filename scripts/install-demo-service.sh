#!/usr/bin/env bash
set -euo pipefail

# Register the public demo instance as two launchd jobs:
#   com.rss-reader.demo        — the app (same binary as prod, demo DB, no auth)
#   com.rss-reader.demo-reset  — restores the seed DB every RESET_INTERVAL (6h)
#
# Run once on the Mac after demo-deploy.sh has built the binary + client. A seed
# DB must exist at data/demo-seed.db (see seed/README.md) before the first reset.
#
# Usage: scripts/install-demo-service.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=demo-lib.sh
source "$SCRIPT_DIR/demo-lib.sh"

[ -x "$DEMO_BIN" ] || {
  echo "error: demo binary not found at $DEMO_BIN"
  echo "       run scripts/demo-deploy.sh first to build it, then re-run this script"
  exit 1
}

mkdir -p "$DEMO_DATA" "$DEMO_LOGS" "$(dirname "$DEMO_ENV")"
[ -f "$DEMO_ENV" ] || {
  echo "==> seed $DEMO_ENV (no AUTH — demo is intentionally open)"
  cat > "$DEMO_ENV" <<'ENVEOF'
# Demo instance env. Intentionally NO AUTH_USER/AUTH_PASS — the demo is public.
DB_MAX_SIZE_MB=256
# rsshub_base_url is read from the DB settings; the seed already carries it.
ENVEOF
}

echo "==> write demo app plist → $DEMO_PLIST"
cat > "$DEMO_PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$DEMO_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$DEMO_BIN</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>PORT</key>
		<string>$DEMO_PORT</string>
		<key>LOCAL_API_PORT</key>
		<string>$DEMO_LOCAL_API_PORT</string>
		<key>RSS_DB</key>
		<string>$DEMO_DB</string>
		<key>CLIENT_DIST</key>
		<string>$DEMO_DIST</string>
		<key>LOG_DIR</key>
		<string>$DEMO_LOGS</string>
		<key>RSS_ENV_FILE</key>
		<string>$DEMO_ENV</string>
	</dict>
	<key>WorkingDirectory</key>
	<string>$DEMO_ROOT</string>
	<key>KeepAlive</key>
	<true/>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardErrorPath</key>
	<string>$DEMO_LOGS/server.log</string>
	<key>StandardOutPath</key>
	<string>$DEMO_LOGS/server.log</string>
</dict>
</plist>
PLISTEOF

echo "==> write reset-timer plist → $RESET_PLIST (every ${RESET_INTERVAL}s)"
cat > "$RESET_PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$RESET_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$SCRIPT_DIR/demo-reset.sh</string>
	</array>
	<key>StartInterval</key>
	<integer>$RESET_INTERVAL</integer>
	<key>RunAtLoad</key>
	<false/>
	<key>StandardErrorPath</key>
	<string>$DEMO_LOGS/reset.log</string>
	<key>StandardOutPath</key>
	<string>$DEMO_LOGS/reset.log</string>
</dict>
</plist>
PLISTEOF

echo "==> bootstrap demo app service"
reload_service "$DEMO_LABEL" "$DEMO_PLIST"

echo "==> bootstrap reset timer"
reload_service "$RESET_LABEL" "$RESET_PLIST"

echo "==> health check (loopback :$DEMO_LOCAL_API_PORT)"
if health_check "http://127.0.0.1:$DEMO_LOCAL_API_PORT/healthz"; then
  echo "OK: demo installed, live on :$DEMO_PORT (loopback :$DEMO_LOCAL_API_PORT)"
  echo "    reset every ${RESET_INTERVAL}s via $RESET_LABEL"
  echo "    build the seed DB (seed/README.md) before the first reset fires"
  exit 0
fi
echo "!! HEALTH CHECK FAILED — inspect $DEMO_LOGS/server.log"
exit 1
