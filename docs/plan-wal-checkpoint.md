# Plan: Bound the SQLite WAL with periodic TRUNCATE checkpoints

## Goal
The `-wal` sidecar grew to 426 MB (nearly the size of the 439 MB main DB). SQLite's automatic
checkpoint is always PASSIVE — it copies committed pages back to the main file but reuses the WAL
in place and never shrinks it, so the file stays at its high-water mark (pushed up by write bursts
like startup warming persisting full content across 44 feeds, and grown further whenever a reader
blocks a checkpoint reset). The oversized WAL causes intermittent multi-hundred-ms stalls under
active use (periodic checkpoint work on the single Node thread) and unbounded disk growth that the
size cap doesn't even measure. This is documented SQLite behavior, not a bug: the app is expected
to run periodic RESTART/TRUNCATE checkpoints under sustained load. This adds that.

## Diagnosis (confirmed)
- `PRAGMA journal_mode` = wal, `wal_autocheckpoint` = 1000 (default PASSIVE, never truncates file).
- Reproduced under continuous load (process never idle): occasional bursts spiked to ~388–499 ms
  vs an ~85 ms baseline. Running `PRAGMA wal_checkpoint(TRUNCATE)` shrank the WAL 426 MB → 0 B and
  the follow-up sustained run showed 0 spikes.

## Scope
### In
- `db.ts`: set `synchronous = NORMAL` (the recommended, safe companion to WAL — fewer fsyncs on
  the persist transactions, so each write blocks the loop for less time).
- `maintenance.ts`: add `checkpointWal()` running `PRAGMA wal_checkpoint(TRUNCATE)`.
- `poller.ts`: run `checkpointWal()` once shortly after startup and then on a periodic timer
  (`CHECKPOINT_INTERVAL`, 5 min) so the WAL stays bounded between the 15-min poll / 24-h
  maintenance passes. Skipped under `TEST_DB` (it lives behind the existing poller guard).

### Out
- No change to `journal_mode` (stays WAL), the schema, the size-cap logic, or persistence.
- Not lowering `wal_autocheckpoint` — it wouldn't truncate the file; TRUNCATE is the fix.
- The idle cold-wake (~800 ms after minutes idle) is a separate issue and not addressed here.

## Steps
1. `db.ts` — add `db.pragma('synchronous = NORMAL')` right after the WAL pragma.
2. `maintenance.ts` — add `checkpointWal()`: run `wal_checkpoint(TRUNCATE)`, log a debug line if
   it reports `busy` (readers/writers active — it will retry next interval), warn on error. Never
   throws.
3. `poller.ts` — add `CHECKPOINT_INTERVAL = 5 * 60 * 1000`; in `startPoller()` call
   `checkpointWal()` once at start and `setInterval(checkpointWal, CHECKPOINT_INTERVAL)`.
4. Verify: `npm run fmt` + `npm run lint`; `cd server && npm test`. Deploy, then confirm the WAL
   stays small over time and the sustained-load spikes are gone (`./scripts/burst-latency.sh` and
   watch `ls -lh ~/Deploy/rss-reader/server/rss.db-wal`).

## Risks & Open Questions
- A TRUNCATE checkpoint briefly needs the WAL write lock; if a persist/read is mid-flight it
  returns `busy` and no-ops (safe, retried next interval). Kept small by the 5-min cadence, so each
  checkpoint moves little data and blocks negligibly — unlike the one-off 426 MB reclaim.
- `synchronous = NORMAL` under WAL is crash-safe (no corruption); the only exposure is losing the
  very last committed transaction on power loss — acceptable for an RSS cache.
- 5 min is a starting cadence; a named constant makes it trivial to tune if the WAL still grows.

## Estimated Complexity
Low — one pragma, one small function, one timer. No schema/API/client changes.

## Outcome
Implemented as planned: `db.ts` sets `synchronous = NORMAL`; `maintenance.ts` gained
`checkpointWal()` (`wal_checkpoint(TRUNCATE)`, busy→debug, error→warn, never throws);
`poller.ts` runs it once at startup and every `CHECKPOINT_INTERVAL` (5 min), behind the existing
`TEST_DB` poller guard. `npm run fmt` + `npm run lint` clean; `cd server && npm test` = 108 pass /
0 fail. The live 426 MB WAL was already reclaimed manually during diagnosis (→ 0 B); the periodic
checkpoint keeps it bounded going forward. Deploy + live verification below.
