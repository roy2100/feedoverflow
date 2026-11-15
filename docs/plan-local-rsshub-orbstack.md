# Plan: Run RSSHub locally on OrbStack instead of tunnelling to the VPS

## Goal

Serve `rsshub://` feeds from a memory-capped RSSHub container on the Mac (OrbStack), replacing the
`com.rss-reader.rsshub-tunnel` SSH forward to the RackNerd VPS. The tunnel was down for ~15h
(2026-11-14 20:00 → 2026-11-15 11:40) without anyone noticing, and every `rsshub://` fetch failed
with `connection refused` for that whole window.

## Scope

**In**
- `scripts/rsshub/compose.yml`: `diygod/rsshub:latest`, published on `127.0.0.1:1200` only,
  `restart: unless-stopped`, a hard memory limit plus a matching V8 heap cap, same env as the VPS
  instance (`CACHE_TYPE=memory`, `CACHE_EXPIRE=300`, `CACHE_CONTENT_EXPIRE=300`, `TZ=Asia/Shanghai`).
- Stop and disable the `com.rss-reader.rsshub-tunnel` launchd job (`bootout` + move the plist
  aside, so a reboot doesn't bring it back and fight the container for port 1200).
- Verify all 12 `rsshub://` feeds through the container.
- Docs: runbook note in `scripts/README.md`.

**Out**
- The app's `rsshub_base_url` setting stays `http://127.0.0.1:1200`. The port doesn't change, so
  neither the DB setting nor the app needs touching.
- The VPS RSSHub container stays up: the public demo instance runs on the same box.
- Fixing the four routes that already return 503 upstream (`anthropic/news`, `jiemian/lists/*`).
  That's a separate decision, made after we see whether the latest image fixes them.
- Raising the 10s fetch timeout for `rsshub://` feeds.

## Steps

1. Write `scripts/rsshub/compose.yml`.
2. `docker compose -f scripts/rsshub/compose.yml pull`.
3. `bootout` the tunnel job, move its plist to `~/Library/LaunchAgents/disabled/`, confirm port
   1200 is free.
4. `docker compose up -d`, wait for the container to start serving.
5. Probe every `rsshub://` route and compare with the VPS results. Watch `docker stats` under that
   load, and if the cap is too tight, raise it.
6. Update `scripts/README.md`, append Outcome, commit.

## Risks / open questions

- **Egress from the Mac.** Several routes (`telegram/*`, `zaobao/*`, `anthropic`) depend on sites
  the US VPS reaches directly. From the Mac they only work if the host proxy covers container
  traffic. If they fail locally, the fallback is to set `PROXY_URI` to the host proxy
  (`host.docker.internal`), or to restore the tunnel.
- **Memory cap.** The VPS instance sits at ~265 MiB unconstrained. A cap that's too low means
  OOM kills; `restart: unless-stopped` recovers from those, but they lose the in-memory cache.
- **OrbStack must be running** for the container to serve. It's set as a login item today, but
  that should be confirmed.

## Complexity

Low–Medium. No app code changes; the risk is all network egress.

## Outcome

Implemented as planned with no deviations:

- Created `scripts/rsshub/compose.yml` running `diygod/rsshub:latest` (`container_name: rsshub`), bound to `127.0.0.1:1200:1200` with `mem_limit: 256m`, `memswap_limit: 256m`, `NODE_OPTIONS=--max-old-space-size=192`, `CACHE_TYPE=memory`, `CACHE_EXPIRE=300`, `CACHE_CONTENT_EXPIRE=300`, `TZ=Asia/Shanghai`, `restart: unless-stopped`.
- Pulled `diygod/rsshub:latest`, stopped and unloaded `com.rss-reader.rsshub-tunnel`, moved its plist to `~/Library/LaunchAgents/disabled/com.rss-reader.rsshub-tunnel.plist`, confirmed `:1200` free, and started the container (ready in 2s).
- Probed all 12 `rsshub://` routes against `http://127.0.0.1:1200`:
  - `163/dy2/T1483516375236`: `200` (`5.39s`)
  - `36kr/hot-list`: `200` (`2.03s`)
  - `anthropic/news`: `200` (`3.41s`) — fixed by latest image (was `503` on VPS)
  - `jiemian/lists/2`: `200` (`3.93s`) — fixed by latest image (was `503` on VPS)
  - `jiemian/lists/65`: `200` (`1.80s`) — fixed by latest image (was `503` on VPS)
  - `jiemian/lists/801`: `503` (`0.33s`) — upstream `a.jiemian.com` returns HTTP 404
  - `telegram/channel/abmedia_news`: `200` (`4.28s`)
  - `telegram/channel/tnews365`: `200` (`0.68s`)
  - `telegram/channel/xhqcankao`: `200` (`0.94s`)
  - `wallstreetcn/live/global/1`: `200` (`1.20s`)
  - `zaobao/realtime`: `200` (`9.91s`)
  - `zaobao/realtime/world`: `200` (`18.53s` cold fetch)
- Host Stash TUN covered container egress (`telegram/*`, `zaobao/*`, `anthropic/*`) directly without setting `PROXY_URI`.
- Container memory after probing all 12 routes: `242MiB / 256MiB` (`94.5%`), `OOMKilled=false`, `RestartCount=0`. Note: headroom is tight (~14 MiB); bump to `320m` / `256` if concurrent polling causes OOM restarts later.
- Updated `scripts/README.md`.
