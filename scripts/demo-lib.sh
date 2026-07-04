#!/usr/bin/env bash
# Shared config for the public demo instance scripts (demo-deploy.sh /
# install-demo-service.sh / demo-reset.sh). The demo is the SAME binary as
# production, run as a second launchd job against a throwaway DB that is restored
# from a snapshot every 6h. See docs/demo-instance.md.
#
# Sources lib.sh only to reuse its launchd helpers (reload_service /
# kickstart_service / health_check); all names below intentionally override the
# production values from lib.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

# --- Demo config (env-overridable) --------------------------------------------
DEMO_ROOT="${DEMO_ROOT:-$HOME/Deploy/rss-demo}"
DEMO_LABEL="com.rss-reader.demo"
DEMO_PLIST="$HOME/Library/LaunchAgents/$DEMO_LABEL.plist"
RESET_LABEL="com.rss-reader.demo-reset"
RESET_PLIST="$HOME/Library/LaunchAgents/$RESET_LABEL.plist"

DEMO_PORT="${DEMO_PORT:-3003}"              # tunneled to demo.royl.uk
DEMO_LOCAL_API_PORT="${DEMO_LOCAL_API_PORT:-4003}"
RESET_INTERVAL="${RESET_INTERVAL:-21600}"   # seconds between resets (6h)

DEMO_BIN="$DEMO_ROOT/rss-reader"
DEMO_DATA="$DEMO_ROOT/data"
DEMO_DB="$DEMO_DATA/demo.db"
DEMO_SEED="$DEMO_DATA/demo-seed.db"
DEMO_DIST="$DEMO_ROOT/client/dist"
DEMO_LOGS="$DEMO_ROOT/logs"
DEMO_ENV="$DEMO_ROOT/server/.env"
