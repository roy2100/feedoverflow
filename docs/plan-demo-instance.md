# Plan: Public demo instance (throwaway DB, resets every 6h)

## Goal
Publish a **public, no-login demo** of the RSS reader so the README's "Live demo" link can point
at a real running app, without exposing the owner's real data or write access to the production
instance. The demo is the *same binary* run as a second instance against a **separate, throwaway
SQLite database** that is **restored from a curated snapshot every 6 hours**. Because the DB is
disposable, the demo can stay fully interactive (star, add feed, settings) — the reset undoes any
visitor mess. A build-time banner marks it as an ephemeral demo.

## Scope
Included:
- A build-time **demo banner** in the client, gated by `VITE_DEMO_MODE` (lives on `main`, dormant
  in production). This is the *only* source change.
- A `demo` git branch carrying **additive-only** operational files: deploy/install/reset scripts,
  a demo `.env` example, seed-DB instructions, and a runbook. No edits to existing tracked files,
  so `git merge main` into `demo` never conflicts.
- launchd: a second app service (`com.rss-reader.demo`) + a 6-hour reset timer
  (`com.rss-reader.demo-reset`).
- Runbook additions for the rathole tunnel + Caddy (`demo.royl.uk:8443`).

Explicitly out of scope:
- No read-only API mode (unnecessary — isolation comes from the throwaway DB, not from blocking
  writes).
- No changes to the production instance's ports, DB, auth, or MCP.
- Running the launchd / rathole / Caddy / DNS steps automatically — those touch the production Mac
  and the VPS and are left to the operator via the runbook.

## Design

| | production | demo |
|---|---|---|
| launchd label | `com.rss-reader.app` | `com.rss-reader.demo` (+ `com.rss-reader.demo-reset`) |
| `PORT` (tunneled) | 3002 | 3003 |
| `LOCAL_API_PORT` | 4002 | 4003 |
| `RSS_DB` | `~/Deploy/rss-reader/server/rss.db` | `~/Deploy/rss-demo/data/demo.db` |
| `AUTH_USER/PASS` | set | **unset** (open) |
| `CLIENT_DIST` | prod build | build with `VITE_DEMO_MODE=1` (banner) |
| deploy root | `~/Deploy/rss-reader` | `~/Deploy/rss-demo` |
| public URL | `rss.royl.uk:8443` | `demo.royl.uk:8443` |
| rathole VPS bind | `127.0.0.1:5202` | `127.0.0.1:5203` |

Reset (`scripts/demo-reset.sh`, every 6h): stop `com.rss-reader.demo` → copy
`data/demo-seed.db` over `data/demo.db` (and drop stale `-wal`/`-shm`) → start the service →
health-check. Starred/added junk from visitors is wiped each cycle.

Merge-clean rule: the `demo` branch adds only new files under `scripts/`, `deploy/demo/`, and
`seed/`. All source/UI changes (the banner) live on `main` behind `VITE_DEMO_MODE`, so the demo
branch carries **zero diff** against any file that `main` also owns.

## Steps
1. **`main`** — banner plumbing (dormant in prod):
   - `client/src/components/DemoBanner.tsx` — renders a fixed top bar only when
     `import.meta.env.VITE_DEMO_MODE` is truthy; otherwise `null`.
   - `client/src/main.tsx` — mount `<DemoBanner/>`; subtract the banner height from `--app-height`
     when demo mode is on (0 otherwise, so prod is byte-for-byte equivalent).
   - `client/src/App.tsx` — desktop root `height: 100vh` → `var(--app-height, 100vh)` (mobile
     already reads the var), so the banner reserves space instead of overlapping.
   - `client/src/vite-env.d.ts` — type `VITE_DEMO_MODE`.
   - Verify: `npm run typecheck`, then `VITE_DEMO_MODE=1 npm run build` and a local smoke run.
2. **`demo` branch** — additive ops files:
   - `scripts/demo-lib.sh` — demo config (labels, ports, roots, paths); sources `lib.sh` for the
     launchd helpers.
   - `scripts/demo-deploy.sh` — build client with `VITE_DEMO_MODE=1`, build the binary, sync into
     `~/Deploy/rss-demo`, kickstart.
   - `scripts/install-demo-service.sh` — write both plists (app service + 6h reset timer),
     bootstrap them.
   - `scripts/demo-reset.sh` — snapshot restore (stop → copy seed → start → health-check).
   - `deploy/demo/.env.example` — demo env (no `AUTH_*`; small `DB_MAX_SIZE_MB`).
   - `seed/README.md` — how to build `demo-seed.db` from a curated OPML.
   - `docs/demo-instance.md` — full runbook (ports, VPS `server.toml` demo service, Caddyfile
     `demo.royl.uk`, Mac `client.toml` demo service, DNS, launchd, reset, verification).
   - Verify: `shellcheck` the scripts; confirm `git merge --no-commit main` is clean.

## Risks & Open Questions
- **Open write API, no auth.** A visitor can add feeds / import OPML, making the demo fetch
  arbitrary public URLs (mild open-proxy). The existing SSRF guard blocks internal targets; the 6h
  reset limits persistence. Acceptable for a low-traffic personal demo; revisit if abused
  (rate-limit or drop `add_feed`/`import_opml` on the demo later).
- **Shared outbound resources** (RSSHub tunnel, network) with production — read-only sharing, fine.
- **Seed drift** — if the schema changes, the seed DB must be rebuilt; migrations run on open so a
  stale-but-older seed still upgrades, but a seed newer than the binary would not downgrade.
- **DNS/cert for `demo.royl.uk`** — needs an A record + DNS-01 cert issuance (same flow as
  `rss.royl.uk`); operator step.

## Estimated Complexity
Medium — small, well-isolated client change plus a set of ops scripts and a runbook; no
production-instance risk, but several manual deploy/tunnel steps for the operator.
