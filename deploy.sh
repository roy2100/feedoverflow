#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"

log() { echo "==> $*"; }

cd "$REPO"

log "Installing server dependencies..."
npm --prefix server install

log "Installing client dependencies..."
npm --prefix client install

log "Building frontend..."
npm --prefix client run build

log "Updating Caddy config..."
ln -sf /Users/lielienan/Project/networth/Caddyfile /opt/homebrew/etc/caddy/Caddyfile
caddy reload --config /opt/homebrew/etc/caddy/Caddyfile

log "Restarting backend..."
launchctl kickstart -k "gui/$(id -u)/rss-reader.backend"

log "Done. Backend log: tail -f /tmp/rss-reader-backend.log"
