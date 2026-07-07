#!/usr/bin/env bash
# Restore the demo DB from its snapshot (cron: every 6h). Stops the container so
# SQLite isn't mid-write, copies the seed over the live DB, restarts, healthchecks.
set -euo pipefail
DIR=/root/rss-demo
C="docker compose -f $DIR/docker-compose.yml"
log() { echo "[$(date '+%FT%T%z')] $*"; }

[ -f "$DIR/data/demo-seed.db" ] || { log "seed missing at $DIR/data/demo-seed.db"; exit 1; }

log "stop demo"
$C stop demo >/dev/null 2>&1 || true

cp -f "$DIR/data/demo-seed.db" "$DIR/data/demo.db"
rm -f "$DIR/data/demo.db-wal" "$DIR/data/demo.db-shm"
chown 10001:10001 "$DIR/data/demo.db"

log "start demo"
$C start demo >/dev/null 2>&1

for _ in $(seq 1 20); do
  if curl -fsS -m3 http://127.0.0.1:3013/healthz >/dev/null 2>&1; then
    log "reset OK — demo healthy"
    exit 0
  fi
  sleep 2
done
log "reset FAILED — demo unhealthy after restart"
exit 1
