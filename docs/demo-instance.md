# Public demo instance runbook

A **public, no-login demo** of the reader at `https://demo.royl.uk:8443`, alongside the
production `rss.royl.uk:8443`. It is the *same binary* run as a second launchd job against a
**throwaway SQLite DB** that is **restored from a snapshot every 6 hours**, so visitors can click
around freely (star, add feeds, settings) and the reset undoes it. A build-time banner marks it as
ephemeral.

Design rationale and the full port/label table: `docs/plan-demo-instance.md`. The production
tunnel this mirrors: `docs/rathole-vps-tunnel.md`.

## Topology

```
Public ─HTTPS :8443─► Caddy (SNI: demo.royl.uk) ─► 127.0.0.1:5203
        │                                              │
        │                                        rathole(VPS) ══tunnel══► rathole(Mac)
        │                                                                     │
        └────────────────────────────────────────────────► demo app :3003 ◄──┘
                                          (RSS_DB=demo.db, no auth, banner build)
```

| thing | production | demo |
|---|---|---|
| launchd | `com.rss-reader.app` | `com.rss-reader.demo` + `com.rss-reader.demo-reset` |
| app `PORT` | 3002 | 3003 |
| `LOCAL_API_PORT` | 4002 | 4003 |
| deploy root | `~/Deploy/rss-reader` | `~/Deploy/rss-demo` |
| `RSS_DB` | `.../server/rss.db` | `.../data/demo.db` (reset from `data/demo-seed.db`) |
| auth | on | **off** (public) |
| rathole VPS bind | `127.0.0.1:5202` | `127.0.0.1:5203` |
| public host | `rss.royl.uk:8443` | `demo.royl.uk:8443` |

All the demo tooling lives on the `demo` git branch (additive-only, so `git merge main` stays
clean). The banner itself is on `main`, gated by `VITE_DEMO_MODE`.

## One-time setup

### 1. DNS

Add an A record `demo.royl.uk → <VPS_PUBLIC_IP>`, **DNS-only** (grey cloud) — same reasoning as
`rss.royl.uk` (Cloudflare's proxy won't forward `:8443`). Confirm: `dig +short demo.royl.uk`.

### 2. Mac — build, register, seed

```bash
git switch demo                      # the demo tooling lives here
scripts/demo-deploy.sh               # build banner client + binary → ~/Deploy/rss-demo
scripts/install-demo-service.sh      # register com.rss-reader.demo + the 6h reset timer
```

Build the seed DB (curated feeds/articles) per `seed/README.md`, landing it at
`~/Deploy/rss-demo/data/demo-seed.db`. Then prime the live DB once:

```bash
scripts/demo-reset.sh                # copies the seed → demo.db and restarts

curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4003/healthz   # 200
```

### 3. VPS — rathole server: add the demo service

Append to `/etc/rathole/server.toml` (same token/transport as production):

```toml
[server.services.demo]
token = "<TUNNEL_TOKEN>"             # may reuse the production token
bind_addr = "127.0.0.1:5203"         # demo traffic surfaces here; localhost-only
```

```bash
systemctl restart rathole-server
ss -tlnp | grep 5203                 # rathole should own it once the Mac client connects
```

### 4. VPS — Caddy: add the demo site

Append to `/etc/caddy/Caddyfile`:

```caddy
demo.royl.uk:8443 {
	reverse_proxy 127.0.0.1:5203
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
	encode zstd gzip
}
```

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy               # issues the demo.royl.uk cert via DNS-01
```

Port `8443` is already open; Caddy multiplexes both hosts on it by SNI — no new firewall rule.

### 5. Mac — rathole client: add the demo service

Append to `~/Deploy/rathole/client.toml`:

```toml
[client.services.demo]
token = "<TUNNEL_TOKEN>"             # must match the VPS
local_addr = "127.0.0.1:3003"        # the demo app
```

Restart the rathole client launchd job (see `docs/rathole-vps-tunnel.md` for its label).

## Verify

```bash
# VPS sees the tunneled demo app
ssh <VPS> 'curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5203/healthz'   # 200
# public endpoint
curl -sS -o /dev/null -w '%{http_code}\n' https://demo.royl.uk:8443/healthz           # 200
curl -sSI https://demo.royl.uk:8443/ | head -n1                                        # HTTP/2 200
```

Open `https://demo.royl.uk:8443` — the amber "Live demo — resets every 6 hours" banner should sit
at the top, and no login should be required. Star something, then run `scripts/demo-reset.sh` and
confirm it reverts.

## Operating it

| task | command |
|---|---|
| roll out a new demo build | `git switch demo && scripts/demo-deploy.sh` |
| pull production updates into the demo | `git switch demo && git merge main` (additive branch → clean) |
| force a reset now | `scripts/demo-reset.sh` |
| change reset cadence | `RESET_INTERVAL=<sec> scripts/install-demo-service.sh` (re-registers the timer) |
| rebuild the seed | see `seed/README.md`, then `scripts/demo-reset.sh` |
| app logs | `tail -f ~/Deploy/rss-demo/logs/app.log` |
| reset logs | `tail -f ~/Deploy/rss-demo/logs/reset.log` |
| stop the demo | `launchctl bootout gui/$(id -u)/com.rss-reader.demo` (and `…demo-reset`) |

## Notes / risks

- **Open write API.** No auth means a visitor can add feeds / import OPML, making your Mac fetch
  arbitrary public URLs. The SSRF guard blocks internal targets; the 6h reset caps persistence. If
  abused, drop `add_feed`/`import_opml` on the demo or rate-limit at Caddy.
- The demo shares the outbound network and the RSSHub tunnel with production (read-only sharing).
- Once live, set the README "Live demo" link to `https://demo.royl.uk:8443`.
