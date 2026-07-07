# Plan: Migrate the public demo from the Mac to RackNerd (Docker)

## Goal
Move the `demo.royl.uk:8443` public demo off the Mac and onto the RackNerd VPS
(192.129.240.237) as a Docker container, to free the Mac from running a second app
instance + reset timer + its rathole/Caddy path. The production app (`rss.royl.uk`) stays
on the Mac, untouched.

## Why RackNerd is a better home for the demo
- It already has a **public IP** and runs Docker + a RSSHub container (`127.0.0.1:1200`).
- Being public, the demo needs **no rathole tunnel and no Aliyun Caddy** — Caddy runs
  directly on RackNerd and terminates TLS for `demo.royl.uk:8443`.
- It is a **US** host, so the historic blocker (building Caddy with the Cloudflare DNS
  module from mainland China) does not apply — the standard Caddy build/module fetch works.
- The demo DB is throwaway (reset every 6h), so hosting it off-box carries no data risk.

## Current state (verified)
- Mac launchd: `com.rss-reader.demo` (PORT 3013 / LOCAL_API 4013, no auth) +
  `com.rss-reader.demo-reset` (6h) + `com.rss-reader.rathole` + `com.rss-reader.rsshub-tunnel`.
- Seed snapshot: `~/Deploy/rss-demo/data/demo-seed.db` (~753 KB) — reused as-is.
- Client demo banner is build-time (`VITE_DEMO_MODE=1`), already on `main`, dormant in prod.
- royl.uk DNS is on **Cloudflare (grey-cloud/DNS-only)**; certs for `:8443` come via the
  **Cloudflare DNS-01** challenge (port 8443 avoids ICP filing; 80/443 stay closed).

## Target architecture
```
Public ─HTTPS :8443─► Caddy (RackNerd, cert via Cloudflare DNS-01)
                         └─ reverse_proxy → 127.0.0.1:3013 (demo container, no auth)
Demo container ── localhost:1200 ─► RSSHub (host, already running)   [host networking]
6h reset: host cron → restore demo-seed.db over the live DB → restart container
```
Decisions baked in:
- **Caddy directly on RackNerd**, not the Aliyun path (drops rathole + Aliyun for the demo).
- Demo app uses **host networking** so `localhost:1200` reaches the host RSSHub and the seed's
  `rsshub_base_url=http://localhost:1200` needs no change; ufw keeps 3013 off the public net
  (only 22 + 8443 inbound).
- Reset stays a **6h snapshot restore**, reimplemented for Docker (stop → copy seed → start →
  healthcheck) driven by host cron instead of a launchd timer.

## Steps
### A. Source (main) — one small, dormant-by-default change
1. `Dockerfile`: add `ARG VITE_DEMO_MODE` to the client stage and pass it into `npm run build`.
   Default empty → production/open-source image unchanged.

### B. RackNerd — stand up the demo (I can do this over SSH; non-destructive)
2. `scp` `demo-seed.db` from the Mac to `~/rss-demo/data/demo-seed.db` on RackNerd.
3. `~/rss-demo/docker-compose.yml`: build the app image with `VITE_DEMO_MODE=1`,
   `network_mode: host`, `PORT=3013`, `LOCAL_API_PORT=4013`, no `AUTH_*`, volume/bind for the
   throwaway DB seeded from `demo-seed.db`, `restart: unless-stopped`.
4. Seed the live DB from the snapshot; `docker compose up -d --build`; verify
   `curl 127.0.0.1:3013/healthz` = ok and the served HTML carries the demo banner.
5. `~/rss-demo/reset.sh` + a **cron** entry every 6h (snapshot restore + restart + healthcheck).
6. Tear down the earlier plain smoke-test container (`rss-reader-app-1`) so only the demo runs.

### C. RackNerd — public TLS  (needs a Cloudflare API token — operator input)
7. Install Caddy with the `caddy-dns/cloudflare` module (build via the official Caddy builder
   image; RackNerd's network can fetch it). Run it as a container or a systemd unit.
8. Caddyfile: `demo.royl.uk:8443 { reverse_proxy 127.0.0.1:3013 }` with the Cloudflare DNS-01
   token in its env; matches the existing rss.royl.uk cert flow.
9. `ufw`: ensure inbound is default-deny with **22 and 8443** allowed (keep SSH!); 3013/4013 stay
   private.

### D. Cut over (operator-owned, consequential)
10. Cloudflare: repoint `demo.royl.uk` A record → **192.129.240.237** (grey-cloud/DNS-only).
11. Verify `https://demo.royl.uk:8443` externally (cert valid, banner shows, reset works).
12. Decommission the Mac demo: `launchctl bootout` `com.rss-reader.demo` +
    `com.rss-reader.demo-reset`; remove the demo service from the Mac rathole `client.toml` and
    the Aliyun `server.toml`; remove the `demo.royl.uk` block from the Aliyun Caddyfile. Leave the
    production `rss.royl.uk` path fully intact.

## Risks & Open Questions
- **Cloudflare API token** for DNS-01 is required and only the operator can provide it (a
  scoped Zone:DNS-edit token for royl.uk). Blocks step 7–8.
- **DNS repoint + Mac/Aliyun teardown** (steps 10, 12) touch production infra and DNS — operator
  confirms before I run them; ordered so DNS flips only after RackNerd serves cleanly.
- **ufw**: editing the firewall on a remote VPS risks SSH lockout — 22 is allowed explicitly and
  state is checked before any `enable`.
- **Open write API, no auth** on the demo (add feed / OPML import) — same as today; the 6h reset
  + SSRF guard bound the blast radius.
- **Seed schema drift**: migrations run on open, so the existing seed upgrades fine on a newer
  binary.

## Estimated Complexity
Medium — the container/seed/reset (B) is straightforward and reversible; the real gates are the
Cloudflare token, the DNS cutover, and cleanly retiring the Mac/Aliyun demo path.
