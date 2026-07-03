#!/usr/bin/env bash
set -euo pipefail

# Unregister the Go backend launchd job: stop it and remove the LaunchAgent plist.
# The deployed binary, DB, and client under ~/Deploy/rss-reader are left untouched —
# re-register with scripts/install-service.sh.
#
# Usage: scripts/uninstall-service.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

if [ ! -f "$PLIST" ]; then
  echo "==> service not installed ($PLIST missing) — nothing to do"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  exit 0
fi

echo "==> stop + unregister $LABEL"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

echo "==> remove $PLIST"
rm -f "$PLIST"

echo "OK: service uninstalled (deployed files under $DEPLOY_ROOT kept)"
