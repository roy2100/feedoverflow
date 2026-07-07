# Demo instance on RackNerd (Docker)

The public demo (`https://demo.royl.uk:8443`) runs on the **RackNerd VPS**
(`192.129.240.237`, x86_64, US) as Docker, instead of the Mac launchd instance described in
`demo-instance.md`. This offloads the Mac (it no longer runs a second app instance + reset
timer). Production `rss.royl.uk` is unchanged, still on the Mac.

Why RackNerd is a good fit: it already has a public IP + Docker + the RSSHub container, and being
in the US it can obtain the cert with a plain HTTP-01 challenge — no Cloudflare API token, unlike
`rss.royl.uk` (which needs DNS-01 because 80/443 are closed on Aliyun to avoid ICP filing).

## Layout on the VPS

```
~/rss-reader/            repo checkout (build context; `git pull` to update)
~/rss-demo/
  docker-compose.yml     deploy/demo/docker/docker-compose.yml
  reset.sh               deploy/demo/docker/reset.sh   (chmod +x)
  data/                  demo.db + demo-seed.db   (MUST be chown 10001:10001)
  logs/                  reset.log
~/caddy/
  docker-compose.yml     deploy/demo/docker/caddy/docker-compose.yml
  Caddyfile              deploy/demo/docker/caddy/Caddyfile
  data/ config/          Caddy state (certs live here)
```

## Key facts / gotchas

- **App image**: built from `~/rss-reader` with `--build-arg VITE_DEMO_MODE=1` so the demo banner
  is baked in (`client/src/components/DemoBanner.tsx`). It's the same multi-stage `Dockerfile` the
  open-source build uses.
- **uid 10001**: the image runs as a non-root user. The bind-mounted `~/rss-demo/data` must be
  `chown -R 10001:10001` or SQLite fails with *"attempt to write a readonly database"*. `reset.sh`
  re-chowns `demo.db` after restoring the seed.
- **Loopback publish**: the demo is published on `127.0.0.1:3013` only (the box has no firewall);
  Caddy on the same host fronts it. Never bind it to `0.0.0.0` without a firewall — it has no auth.
- **RSSHub**: the seed's `rsshub_base_url` is `http://localhost:1200`. If you need `rsshub://`
  feeds to refresh in the container, either give the demo `network_mode: host` (so `localhost:1200`
  reaches the host RSSHub) or point it at the RSSHub container over a shared docker network. The
  seed already carries fetched articles, so the demo renders content without live RSSHub.

## Cert: token-free HTTP-01

`443` is taken by **sing-box** (the box's proxy — do not disturb it), so the Caddyfile disables
the TLS-ALPN challenge and Caddy uses **HTTP-01 on :80** (which was free). Caddy issues and
auto-renews the Let's Encrypt cert for `demo.royl.uk`, serving the site on `:8443`. The Caddy
container uses `network_mode: host` to bind `:80` + `:8443` and reach the demo on `127.0.0.1:3013`.

DNS requirement: `demo.royl.uk` A → `192.129.240.237`, **Cloudflare grey-cloud (DNS-only)** — the
`:8443` port is non-standard so an orange-cloud proxy would never reach it, and HTTP-01 needs
`:80` to hit RackNerd directly.

## Deploy from scratch

```bash
# on the VPS
git clone <repo> ~/rss-reader                       # or: cd ~/rss-reader && git pull
mkdir -p ~/rss-demo/data ~/rss-demo/logs ~/caddy/data ~/caddy/config

# copy the ops files from the repo
cp ~/rss-reader/deploy/demo/docker/docker-compose.yml ~/rss-demo/
cp ~/rss-reader/deploy/demo/docker/reset.sh           ~/rss-demo/ && chmod +x ~/rss-demo/reset.sh
cp ~/rss-reader/deploy/demo/docker/caddy/*            ~/caddy/

# seed DB: build one per seed/README.md, or copy an existing demo-seed.db into
# ~/rss-demo/data/, then seed the live DB and fix ownership
cp ~/rss-demo/data/demo-seed.db ~/rss-demo/data/demo.db
chown -R 10001:10001 ~/rss-demo/data

# start the app, then Caddy
docker compose -f ~/rss-demo/docker-compose.yml up -d --build
docker compose -f ~/caddy/docker-compose.yml up -d

# 6h reset via cron
( crontab -l 2>/dev/null; echo "0 */6 * * * /root/rss-demo/reset.sh >> /root/rss-demo/logs/reset.log 2>&1" ) | crontab -
```

## Verify

```bash
# on the VPS — correct SNI matters, so use --resolve (not a bare 127.0.0.1 URL)
curl -sS --resolve demo.royl.uk:8443:127.0.0.1 https://demo.royl.uk:8443/healthz     # ok
docker compose -f ~/caddy/docker-compose.yml logs | grep "certificate obtained"      # issued
```

## Update the demo

```bash
cd ~/rss-reader && git pull
docker compose -f ~/rss-demo/docker-compose.yml up -d --build   # rebuild + restart
```

## Reset behaviour

`reset.sh` (cron, every 6h): stop the container → copy `demo-seed.db` over `demo.db` → drop stale
`-wal`/`-shm` → chown → start → healthcheck. Any feeds/stars a visitor added are wiped each cycle.
