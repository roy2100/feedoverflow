# scripts — ops, deploy & service management

All ops scripts for FeedOverflow. Deploy/service scripts run the Go backend
(`server-go/`) in production as the launchd job `com.feedoverflow.app` →
`~/Deploy/feedoverflow/feedoverflow`, serving `~/Deploy/feedoverflow/server/rss.db` and
`client/dist` behind the tunnel/Caddy front end. Deploy responsibilities are split so a
rollout never touches the service definition and a one-time setup never rebuilds.

## Scripts

| Script | What it does |
|--------|--------------|
| `deploy.sh` | Build client + cgo Go binary on the Mac, sync into `~/Deploy/feedoverflow`, then bootstrap, start, and health-check the installed service. Errors if its plist has not been installed. |
| `install-service.sh` | Write the launchd plist pointing at the deployed binary. It does **not** bootstrap or start the service. Run once before the first `deploy.sh`. |
| `uninstall-service.sh` | Stop + remove the launchd plist. Deployed files under `~/Deploy/feedoverflow` are kept. |
| `service-stats-mac.sh` | Read the backend's NDJSON `resource sample` records into an aligned table (RSS, heap, DB size, CPU%, uptime). |
| `lib.sh` | Shared config vars + launchd helpers (`reload_service`, `kickstart_service`, `health_check`) sourced by the deploy/service scripts. |
| `burst-latency.sh` | Concurrent-burst latency smoke test against a running server (loopback `:4002`). |
| `loc.sh` | Lines-of-code report for the repo. |

## Env the Go plist sets

- `PORT=3002`, `LOCAL_API_PORT=4002`
- `RSS_DB=~/Deploy/feedoverflow/server/rss.db` (the production DB — unchanged schema)
- `CLIENT_DIST=~/Deploy/feedoverflow/client/dist`
- `LOG_DIR=~/Deploy/feedoverflow/logs` (NDJSON → `app.log`)
- `RSS_ENV_FILE=~/Deploy/feedoverflow/server/.env` (loads `AUTH_USER`/`AUTH_PASS`)

## Fresh-box bootstrap

The first setup needs both scripts once, in order:

1. `scripts/install-service.sh` — writes the plist without starting the service.
2. `scripts/deploy.sh` — builds the binary + client, then bootstraps and starts the
   service.

Thereafter, roll out new builds with `scripts/deploy.sh` alone.

The binary is cgo (`mattn/go-sqlite3`), so it must be **built on the Mac**
(`CGO_ENABLED=1`, Xcode command-line tools) — no cross-compile.
