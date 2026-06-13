# Plan: Service resource self-monitoring + log-reading stats script

## Goal
Add lightweight, dependency-free monitoring of the long-running backend's memory and
CPU. The process logs one structured sample per interval via the existing slog logger,
and a shell script reads those samples back into an aligned table for ops inspection.

## Scope
- Included: an in-process periodic resource sampler (RSS/heap/external/CPU%/uptime) and
  a `service-stats.sh` reader script.
- Out of scope: any external agent (pm2/prometheus), new runtime deps, dashboards,
  alerting.

## Discovered facts (drive the implementation)
- Logger: shared `logger` in `server/logger.ts` (vendored slog). Sub-context via
  `logger.child({ mod: 'resource' })` — same idiom as `poller.ts`/`maintenance.ts`.
- Schedulers: background jobs start from `index.ts`'s `app.listen` callback
  (`startCacheWarming()`, `startPoller()`). Each module self-gates with
  `if (process.env.TEST_DB) return;` (no production-only gate; runs in dev too).
- Deployed log dir: `~/Deploy/rss-reader/logs` (see `install-service.sh`,
  `deploy.sh`). Active file `app.log`; `LOG_DIR` overrides (logger.ts honors it too).
- Rotation naming (slog `FileSink.rotate`): `app-YYYYMMDD-HHMMSS-mmm.log` then gzipped
  to `app-YYYYMMDD-HHMMSS-mmm.log.gz`. ISO-derived → lexical glob sort == chronological.

## Steps
1. `server/resource.ts` — `startResourceMonitor()`, gated on `TEST_DB`. Boot sample
   seeds the CPU/wall baseline and logs `cpuPercent: null`; each interval (default 5
   min) logs rssMb/heapUsedMb/heapTotalMb/externalMb (0.1 MB), per-core CPU% from the
   `process.cpuUsage()` delta over `hrtime` elapsed, and uptimeSec.
2. `server/index.ts` — call `startResourceMonitor()` in the listen callback alongside
   the other background services.
3. `service-stats.sh` (repo root, `chmod +x`) — collect resource lines from `app.log`
   (and, with `--all`, gz archives oldest-first via `zgrep`), parse each NDJSON line in
   `node -e` (robust to field order), render local-time aligned table; `null` CPU → `-`.
   `LOG_DIR` overridable, defaults to the deploy path.
4. Run `npm run typecheck` and the test suite; commit + push (conventional commit).

## Risks & Open Questions
- CPU% expressed as percent of one core (>100 possible on multi-core); documented in
  output/code so it isn't misread.
- macOS `zgrep` availability: ships with the base system (`/usr/bin/zgrep`).

## Estimated Complexity
Low — two small additions, no schema/dependency changes.

## Outcome
Implemented as planned, no deviations.
- `server/resource.ts` — `startResourceMonitor()`, `mod: 'resource'` child logger,
  5-min interval, boot sample logs `cpuPercent: null`, per-core CPU% from the
  `cpuUsage()`/`hrtime` delta. Wired into `index.ts`'s listen callback; TEST_DB-gated.
- `service-stats.sh` (repo root, executable) — `LOG_DIR`-overridable (defaults to the
  deploy path), `--all` folds in gz archives oldest-first via `zgrep`, parses NDJSON in
  `node -e`, renders a local-time aligned table, `null` CPU → `-`.
- Verified: typecheck clean, all 42 tests pass, and the script was exercised against a
  synthetic log dir (active + gz archive) confirming field-order robustness, local-time
  conversion (vs `TZ=UTC`), null handling, and chronological `--all` ordering.
- Zero new runtime dependencies.
