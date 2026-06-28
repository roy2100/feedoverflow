# Plan: Linux deployment scripts

## Goal
Mirror the four macOS `scripts/*-mac.sh` helpers with Linux equivalents that manage
the app via a **systemd system service**. Unlike the mac flow (which rsyncs to
`~/Deploy/rss-reader`), the Linux deploy runs **in place**: the deploy root is the
current repo directory.

## Scope
- Included: `install-service-linux.sh`, `uninstall-service-linux.sh`, `update-linux.sh`,
  `service-stats-linux.sh` under `scripts/`.
- Service model: systemd **system** unit at `/etc/systemd/system/rss-reader.service`
  (chosen by user — runs at boot independent of login; install/uninstall need sudo).
- Out of scope: systemd `--user` units, Cloudflare tunnel setup, git pull (update
  rebuilds the current checkout, like `deploy-mac.sh`).

## Steps
1. `install-service-linux.sh` (sudo) — resolve repo root from script location, capture
   absolute `node` path (resolving through `$SUDO_USER` if needed), write a system unit
   running `node $ROOT/server/index.ts` as the invoking user (`$SUDO_USER`), `Restart=always`,
   `PORT`/`NODE_ENV` env; `daemon-reload` + `enable --now`. Create + chown `$ROOT/logs`.
2. `uninstall-service-linux.sh` (sudo) — `disable --now`, remove unit, `daemon-reload`.
3. `update-linux.sh` (runs as repo owner; escalates only for restart) — build client,
   `npm install --omit=dev` server, then `sudo systemctl restart rss-reader`.
4. `service-stats-linux.sh` — same NDJSON resource-table parser as the mac version, with
   `LOG_DIR` defaulting to `$ROOT/logs` (the in-place log location per `logger.ts`).

## Risks & Open Questions
- `node` ≥ 24 required (native TS type-stripping); install script errors if `node` absent.
- Under `sudo`, PATH may not include `node`; resolved via `$SUDO_USER`'s login shell.
- Service runs as `$SUDO_USER` (not root) so `node_modules`/logs stay user-owned.

## Estimated Complexity
Low — four self-contained shell scripts adapted from existing mac equivalents.

## Outcome
Created under `scripts/` (all `chmod +x`, `bash -n` clean):
- `install-service-linux.sh` — sudo; writes `/etc/systemd/system/rss-reader.service`
  (runs as `$SUDO_USER`, `node $ROOT/server/index.ts`, `Restart=always`, embeds an
  absolute node path + PATH), `daemon-reload`, `enable --now`. Errors if node missing.
- `uninstall-service-linux.sh` — sudo; `disable --now`, remove unit, `daemon-reload`.
- `update-linux.sh` — non-root; build client, `npm install --omit=dev` server, then
  `sudo systemctl restart rss-reader` (refuses to run under sudo to keep deps user-owned).
- `service-stats-linux.sh` — identical NDJSON parser to the mac version; `LOG_DIR`
  defaults to `$ROOT/logs`.
No deviations from the plan.
