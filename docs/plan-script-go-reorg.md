# Plan: Reorganize `script-go/` ops scripts

## Goal
The Go cutover is complete and the legacy Node backend was deleted (`3d65b39`), so
`script-go/`'s framing — a monolithic `deploy.sh` that also creates the launchd
service, plus a `rollback.sh` that restores the now-nonexistent Node plist — no longer
matches reality. Reorganize the directory into a clean, single-responsibility set of
Go-only service-management scripts.

## Scope
Included:
- Split service registration out of `deploy.sh` into a new `install-service.sh`.
- `deploy.sh` becomes build + sync + kickstart only (errors if the service isn't installed).
- New `uninstall-service.sh` (bootout + remove plist).
- Delete `rollback.sh` (restored the deleted Node plist — dead path).
- Factor shared config + helpers into `lib.sh`.
- `service-stats-mac.sh` stays byte-for-byte unchanged.
- Update `script-go/README.md`, `server-go/Makefile` targets, and `CLAUDE.md` references.

Out of scope:
- The `scripts/` (Node-era) directory and `service-stats-mac.sh` internals.
- Any change to the plist contents / env the service runs with (same PORT, DB, etc.).
- Historical `docs/plan-*.md` records (left as-is).

## Steps
1. `lib.sh` — add shared config vars (`DEPLOY_ROOT`, `LABEL`, `PLIST`, `PORT`,
   `LOCAL_API_PORT`, `BIN`) and helpers `kickstart_service`, `health_check`; keep
   `reload_service`.
2. `install-service.sh` (new) — require `$BIN` to exist (else point to `deploy.sh`),
   write the launchd plist, `reload_service` (bootstrap), health-check the loopback port.
3. `deploy.sh` — drop plist writing + Node `.node.bak` backup; build client + Go binary,
   sync, require the plist to be installed (else point to `install-service.sh`),
   `kickstart_service`, health-check.
4. `uninstall-service.sh` (new) — `launchctl bootout` + `rm` the plist.
5. `rm script-go/rollback.sh`.
6. `server-go/Makefile` — replace the `rollback` target with `install-service` /
   `uninstall-service`; keep `deploy`.
7. Update `script-go/README.md` (script table, cutover checklist) and the two
   `CLAUDE.md` deploy/rollback lines.

## Risks & Open Questions
- Fresh-box bootstrap needs both scripts once, in order: `deploy.sh` (builds the binary,
  then errors "run install-service") → `install-service.sh` (registers + starts). Steady
  state is `deploy.sh` alone. This ordering is documented in the README.
- No functional change to the running service, so no runtime regression expected; the
  risk is purely in the launchctl bootstrap/kickstart plumbing, covered by the existing
  `reload_service` retry hardening.

## Estimated Complexity
Low–Medium — 4 shell scripts + Makefile + 2 doc files, no application code.

## Outcome
Done as planned. Final `script-go/` layout:
- `install-service.sh` (new) — writes the plist + bootstraps + health-checks; requires `$BIN` to exist.
- `deploy.sh` — reduced to build + sync + `kickstart_service` + health-check; errors if the plist isn't installed. Dropped the old inline plist writer and the Node `.node.bak` backup.
- `uninstall-service.sh` (new) — `launchctl bootout` + `rm` the plist.
- `rollback.sh` — deleted (restored the removed Node plist).
- `lib.sh` — now also holds shared config vars + `kickstart_service` / `health_check` helpers.
- `service-stats-mac.sh` — unchanged.

Also updated `server-go/Makefile` (`rollback` target → `install-service` / `uninstall-service`), `script-go/README.md`, and the `CLAUDE.md` deploy/rollback lines. Validated with `bash -n` (shellcheck not installed on this box). No deviations.
