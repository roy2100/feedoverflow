# Plan: Structured logging with slog

## Goal
Replace the server's ad-hoc `console.log` / `console.error` calls with a vendored
single-file structured logger ([slog](https://github.com/roy2100/slog)). This gives
NDJSON log files with size rotation + gzip + retention, pretty TTY output in dev,
serialized error/cause chains, and a single shared logger used across modules — so the
logs become greppable/streamable for both humans and agents, and a long-running process
never fills the disk.

## Scope
Included:
- Vendor `server/vendor/slog.ts` (zero-dependency, Node ≥ 24 — local is 24.15.0).
- Add `server/logger.ts` — a shared `logger` instance configured for the deploy layout.
- Replace the two existing `console.*` calls (`index.ts`, `poller.ts`) with `logger.*`.
- Surface previously-swallowed background failures in `cache.ts` at low levels.
- Add process-level `uncaughtException` / `unhandledRejection` logging in `index.ts`.
- `.gitignore` the dev `logs/` dir; update CLAUDE.md / deploy.sh log references.

Out of scope:
- Per-request HTTP access logging middleware (noisy for a single-user app; can add later).
- Shipping logs anywhere off-box.

## Steps
1. Vendor `slog.ts` under `server/vendor/`.
2. `server/logger.ts`: `createLogger({ dir: <root>/logs, filename: 'app', base: { app: 'rss-reader' } })`.
   - Resolve `dir` via `import.meta.dirname/../logs` so it equals the deploy `logs/` dir
     regardless of cwd (prod cwd = deploy root, dev cwd = `server/`).
   - Disable file + console under `TEST_DB` so tests stay clean and write no files.
   - `console: 'auto'` → pretty in a dev TTY, silent under launchd (file is source of truth).
3. `index.ts`: log `server started { port }`; add uncaught/unhandled handlers.
4. `poller.ts`: child logger `{ mod: 'poller' }`; log poll failures with serialized `err`.
5. `cache.ts`: log background refresh / warm failures (debug/warn) instead of silent catch.
6. `.gitignore` add `logs/`; update docs + deploy.sh log path note (`logs/app.log`).
7. `npm run typecheck` + `npm test` to confirm green.

## Risks & Open Questions
- slog requires Node ≥ 24; the deploy plist runs `/usr/local/bin/node`. Local is 24.15.0,
  but if the deploy node is older, slog's `util.styleText` / native TS will break. Verify
  on deploy before shipping.
- launchd `server.log` (raw stdout/stderr) now stays mostly empty in normal operation —
  structured logs live in `logs/app.log`. Docs updated to point there; crash/stderr still
  lands in `server.log`.

## Estimated Complexity
Low — additive, localized; only two existing log calls change behavior.

## Outcome
Done as planned.
- Vendored `server/vendor/slog.ts` (681 lines, zero-dep).
- Added `server/logger.ts` — shared logger, dir = `<server>/../logs`, filename `app`,
  base `{ app: 'rss-reader' }`, file+console disabled under `TEST_DB`, `LOG_LEVEL`/`LOG_DIR` overrides.
- `index.ts`: `server started` log + `unhandledRejection`/`uncaughtException` handlers (fatal → `exit(1)`).
- `poller.ts`: `logger.child({ mod: 'poller' })`; poll failure now `log.warn(..., { err })`.
- `cache.ts`: `logger.child({ mod: 'cache' })`; previously-swallowed warm/refresh failures now
  logged (warn/debug) + `cache warmed` info; extracted a `warm()` helper.
- `.gitignore` `logs/`; deploy.sh + CLAUDE.md log paths point to `logs/app.log`; node floor noted as ≥ 24.
- Verified: `npm run typecheck` clean, `npm test` 30/30 pass, tests create no log files, smoke run
  produces correct NDJSON (schema header + serialized error stack).
- Deviation: both dev and deploy node are 24.15.0, so the Node ≥ 24 risk is moot in practice.
