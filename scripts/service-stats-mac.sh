#!/usr/bin/env bash
set -euo pipefail

# Read the Go backend's structured resource samples (msg="resource sample", emitted by
# server-go/internal/jobs/resource.go) back into an aligned table: local time, RSS, heap,
# DB size, CPU%, uptime.
#
# The Go backend's slog records are NDJSON ({ ts, msg, ctx, ... }) with ctx field names
# rssMb, heapUsedMb, dbMb, cpuPercent, uptimeSec; the Go sample carries no ctx.mod, so
# rows are keyed on the message "resource sample". Parsing uses jq (not node) to keep the
# Go-stack tooling free of a Node runtime dependency.
#
# Usage:
#   ./scripts/service-stats-mac.sh            # active log only
#   ./scripts/service-stats-mac.sh --all      # also include gzipped rotated archives (chronological)
#   LOG_DIR=/some/path ./scripts/service-stats-mac.sh
#
# Log dir mirrors internal/logger + the deploy layout (scripts/deploy.sh sets LOG_DIR):
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
# keeps rows chronological. Pre-filter to resource lines; jq does the real parsing.
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

samples="$(collect)"
if [ -z "$samples" ]; then
  echo "no resource samples found" >&2
  exit 0
fi

# Parse each NDJSON line with jq (robust to field-order changes via fromjson?), pull the
# nested ctx.* fields, format the UTC `ts` in local time (strflocaltime), and print an
# aligned table. The header is repeated at the bottom so it stays visible after a long scroll.
printf '%s\n' "$samples" | jq -R -s -r '
  def num(v): if v == null then "-" else (v | tostring) end;
  def spaces($n): if $n <= 0 then "" else (" " * $n) end;
  ( split("\n")
    | map(select(length > 0) | (fromjson? // empty))     # skip blank / unparseable lines
    | map(select(._meta | not)                           # skip slog schema header
          | select(.msg == "resource sample"))           # Go samples carry no ctx.mod
    | map(.ctx as $c
        | (.ts | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 | strflocaltime("%Y-%m-%d %H:%M:%S")) as $t
        | [ $t,
            num($c.rssMb),
            num($c.heapUsedMb),
            num($c.dbMb),
            num($c.cpuPercent),                          # boot baseline -> null -> -
            num($c.uptimeSec) ])
  ) as $rows
  | (["time", "rssMb", "heapMb", "dbMb", "cpu%", "uptime"]) as $header
  | ([$header] + $rows) as $all
  | [ range(0; 6) as $i | ($all | map(.[$i] | length) | max) ] as $w   # per-column width
  | def fmt(row):
      [ range(0; 6) as $i
        | (row[$i] as $c
           | if $i == 0 then ($c + spaces($w[$i] - ($c | length)))     # time: left-justified
             else (spaces($w[$i] - ($c | length)) + $c) end) ]         # numbers: right-justified
      | join("  ");
    ([fmt($header)] + ($rows | map(fmt(.))) + [fmt($header)]) | .[]     # header repeated at bottom
'
