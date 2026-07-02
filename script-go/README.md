# script-go — Go-backend deploy & cutover (Phase 12)

Ops scripts for running the Go backend (`server-go/`) in production, kept separate
from the Node `scripts/` so the Node path stays intact for rollback.

The launchd job `com.rss-reader.app` is the single switch: it points at either
`node .../server/index.ts` (Node) or `~/Deploy/rss-reader/server-go` (Go). Both
serve the **same** `~/Deploy/rss-reader/server/rss.db` and `client/dist`, so the
tunnel/Caddy front end is unchanged.

## Scripts

| Script | What it does |
|--------|--------------|
| `deploy.sh` | Build client + cgo Go binary on the Mac, sync into `~/Deploy/rss-reader`, point launchd at the Go binary, reload, health-check. Saves the current plist as `<plist>.node.bak` on first run. |
| `rollback.sh` | Restore `<plist>.node.bak` (Node) and reload. |

## Env the Go plist sets

- `PORT=3002`, `LOCAL_API_PORT=4002`
- `RSS_DB=~/Deploy/rss-reader/server/rss.db` (the existing production DB — unchanged schema)
- `CLIENT_DIST=~/Deploy/rss-reader/client/dist`
- `LOG_DIR=~/Deploy/rss-reader/logs` (NDJSON → `app.log`)
- `RSS_ENV_FILE=~/Deploy/rss-reader/server/.env` (loads `AUTH_USER`/`AUTH_PASS`)

## Cutover checklist

1. `script-go/deploy.sh` — builds, flips launchd to Go, health-checks the loopback port.
2. Verify `https://rss.royl.uk:8443` (public tunnel) and `rss.lan` (Caddy) load and log in.
3. Watch `~/Deploy/rss-reader/logs/app.log` for errors.
4. If anything is wrong: `script-go/rollback.sh` (back to Node in seconds).

The binary is cgo (`mattn/go-sqlite3`), so it must be **built on the Mac**
(`CGO_ENABLED=1`, Xcode command-line tools) — no cross-compile.
