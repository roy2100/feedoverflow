# scripts — ops, deploy & service management

All ops scripts for the RSS reader. Deploy/service scripts run the Go backend
(`server-go/`) in production as the launchd job `com.rss-reader.app` →
`~/Deploy/rss-reader/rss-reader`, serving `~/Deploy/rss-reader/server/rss.db` and
`client/dist` behind the tunnel/Caddy front end. Deploy responsibilities are split so a
rollout never touches the service definition and a one-time setup never rebuilds.

## Scripts

| Script | What it does |
|--------|--------------|
| `deploy.sh` | Build client + cgo Go binary on the Mac, sync into `~/Deploy/rss-reader`, then **kickstart** the installed service and health-check. Errors if the service isn't installed. |
| `install-service.sh` | Write the launchd plist pointing at the deployed binary, bootstrap it, health-check. Run **once** on a fresh box (after `deploy.sh` has built the binary). |
| `uninstall-service.sh` | Stop + remove the launchd plist. Deployed files under `~/Deploy/rss-reader` are kept. |
| `service-stats-mac.sh` | Read the backend's NDJSON `resource sample` records into an aligned table (RSS, heap, DB size, CPU%, uptime). |
| `lib.sh` | Shared config vars + launchd helpers (`reload_service`, `kickstart_service`, `health_check`) sourced by the deploy/service scripts. |
| `burst-latency.sh` | Concurrent-burst latency smoke test against a running server (loopback `:4002`). |
| `loc.sh` | Lines-of-code report for the repo. |

## Env the Go plist sets

- `PORT=3002`, `LOCAL_API_PORT=4002`
- `RSS_DB=~/Deploy/rss-reader/server/rss.db` (the existing production DB — unchanged schema)
- `CLIENT_DIST=~/Deploy/rss-reader/client/dist`
- `LOG_DIR=~/Deploy/rss-reader/logs` (NDJSON → `app.log`)
- `RSS_ENV_FILE=~/Deploy/rss-reader/server/.env` (loads `AUTH_USER`/`AUTH_PASS`)

## Fresh-box bootstrap

The first setup needs both scripts once, in order (they can't be reversed —
`install-service` bootstraps the binary that `deploy` builds):

1. `scripts/deploy.sh` — builds the binary + client, then reports the service isn't
   installed.
2. `scripts/install-service.sh` — writes the plist and starts the service.

Thereafter, roll out new builds with `scripts/deploy.sh` alone.

The binary is cgo (`mattn/go-sqlite3`), so it must be **built on the Mac**
(`CGO_ENABLED=1`, Xcode command-line tools) — no cross-compile.
