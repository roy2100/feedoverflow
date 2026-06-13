#!/usr/bin/env bash
set -euo pipefail

# Read the backend's structured resource samples (mod=resource, emitted by
# server/resource.ts) back into an aligned table: local time, RSS, heap, DB size, CPU%,
# uptime.
#
# Usage:
#   ./service-stats.sh            # active log only
#   ./service-stats.sh --all      # also include gzipped rotated archives (chronological)
#   LOG_DIR=/some/path ./service-stats.sh
#
# Log dir mirrors logger.ts / the deploy layout (install-service.sh, deploy.sh):
# $HOME/Deploy/rss-reader/logs. Override with LOG_DIR.

LOG_DIR="${LOG_DIR:-$HOME/Deploy/rss-reader/logs}"
BASE="app"
ACTIVE="$LOG_DIR/$BASE.log"

ALL=0
[ "${1:-}" = "--all" ] && ALL=1

if [ ! -d "$LOG_DIR" ]; then
  echo "log dir not found: $LOG_DIR (set LOG_DIR to override)" >&2
  exit 1
fi

# slog rotates to $BASE-YYYYMMDD-HHMMSS-mmm.log then gzips to .log.gz. The ISO-derived
# timestamp means the glob sorts oldest-first, so listing archives before the active log
# keeps rows chronological. Pre-filter to resource lines; node does the real parsing.
collect() {
  if [ "$ALL" = "1" ]; then
    shopt -s nullglob
    local archives=("$LOG_DIR/$BASE"-*.log.gz)
    shopt -u nullglob
    local f
    for f in "${archives[@]}"; do
      zgrep -h 'resource sample' "$f" || true
    done
  fi
  [ -f "$ACTIVE" ] && grep -h 'resource sample' "$ACTIVE" || true
}

# Parse each NDJSON line with node (robust to field-order changes), pull the nested
# ctx.* fields, format the UTC `ts` in local time, and print an aligned table. The
# header is repeated at the bottom so it stays visible after a long scroll.
collect | node -e '
  const data = require("fs").readFileSync(0, "utf8");
  const pad = (n) => String(n).padStart(2, "0");
  const num = (v) => (v == null ? "-" : String(v));
  const rows = [];
  for (const line of data.split("\n")) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r._meta) continue;                 // skip slog schema header
    const c = r.ctx || {};
    if (c.mod !== "resource") continue;
    const d = new Date(r.ts);              // ts is UTC ISO-8601; render in local tz
    const time =
      d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
      pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    rows.push([
      time,
      num(c.rssMb),
      num(c.heapUsedMb),
      num(c.dbMb),
      c.cpuPercent == null ? "-" : String(c.cpuPercent),  // boot baseline -> -
      num(c.uptimeSec),
    ]);
  }
  if (rows.length === 0) { console.error("no resource samples found"); process.exit(0); }
  const header = ["time", "rssMb", "heapMb", "dbMb", "cpu%", "uptime"];
  const all = [header, ...rows];
  const w = header.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  const fmt = (row) =>
    row.map((cell, i) => (i === 0 ? cell.padEnd(w[i]) : cell.padStart(w[i]))).join("  ");
  console.log(fmt(header));
  for (const row of rows) console.log(fmt(row));
  console.log(fmt(header));               // repeat header at bottom for long output
'
