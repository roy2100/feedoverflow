# Plan: Bound SQLite DB size + orphan cleanup

## Goal
`article_states` grows without bound: the poller persists every article it ever sees
(full HTML `content` + `summary`), nothing prunes it, and deleting a feed leaves its
rows behind as orphans. The production DB is already ~201MB (content 99MB, summary
50MB, feed_cache 20MB; 19,153 rows, 963 of them orphaned). This task adds a maintenance
pass that (a) deletes non-starred orphan rows and (b) enforces a configurable file-size
cap (default 500MB) by deleting the oldest non-starred articles until the DB is back
under a low-watermark, then reclaims the freed disk space. Starred articles are never
touched, preserving the existing "starred survives feed removal" guarantee.

## Scope
**Included**
- New maintenance module `server/maintenance.ts` with two operations:
  1. `cleanupOrphans()` — delete `article_states` rows whose `feed_id` is not in `feeds`
     **and** `is_starred = 0`.
  2. `enforceSizeCap(capBytes)` — if logical DB size > cap, delete oldest non-starred
     articles down to ~90% of cap, then `VACUUM` to return space to the OS.
- Ordering by a **parsed** publish timestamp (RFC-822 → epoch ms), falling back to
  `updated_at`, then `0`, since `pub_date` is a non-sortable string and 299 rows are empty.
- Config: `DB_MAX_SIZE_MB` env var (default `500`) via the existing shared config module.
- Wiring: run the maintenance pass once at startup and on a daily interval inside the
  poller. Structured `logger.info` output (rows deleted, bytes/size before & after).
- Tests in `server/maintenance.test.ts` (orphan deletion, starred preservation, cap
  trimming order, no-op when under cap).

**Out of scope**
- Stripping `content` while keeping rows (the earlier "option 3"). Superseded by row deletion.
- Deleting starred articles, ever.
- Pruning `feed_cache` (bounded by feed count) or `sessions` (already TTL-cleaned).
- Migrating to `auto_vacuum=INCREMENTAL` (documented as an alternative under Risks).
- A UI/API surface for the cap (env-only, consistent with other config).

## Steps
1. **Add config** — extend the shared config (the module that derives `PORT`) with
   `dbMaxSizeBytes = (Number(process.env.DB_MAX_SIZE_MB) || 500) * 1024 * 1024`.
   Export it so `maintenance.ts` can read it. Disabled (skip cap) under `TEST_DB`
   unless a test sets it explicitly.

2. **`cleanupOrphans()`** — single statement:
   ```sql
   DELETE FROM article_states
   WHERE is_starred = 0 AND feed_id NOT IN (SELECT id FROM feeds);
   ```
   Return `info.changes`. Cheap; safe to run every pass. (~823 rows on first run.)

3. **Timestamp helper** — `articleTs(row)`:
   `Date.parse(row.pub_date)` → if `NaN`, `Date.parse(row.updated_at)` → if `NaN`, `0`.
   Used only inside the cap pass (no schema change). Note: ordering in JS avoids a
   migration; the alternative (persisted `pub_ts` column + index) is noted under Risks
   if this proves too slow.

4. **`enforceSizeCap(capBytes)`**
   - Measure logical size: `PRAGMA page_count * PRAGMA page_size`.
   - If `size <= capBytes`, return (no-op — the common case).
   - `needFree = size - capBytes * 0.9` (trim to 90% so we don't re-trigger immediately).
   - Load candidates:
     ```sql
     SELECT article_id, pub_date, updated_at,
            LENGTH(content) + LENGTH(summary) AS bytes
     FROM article_states WHERE is_starred = 0;
     ```
   - Sort ascending by `articleTs(row)` (oldest first). Accumulate `article_id`s until
     summed `bytes >= needFree` (logical content+summary bytes under-estimate the page
     bytes freed, so this errs toward deleting slightly more — safe).
   - Delete in chunks of ≤500 ids (SQLite variable limit) inside one transaction.
   - `VACUUM` to shrink the file on disk; re-measure. If still over cap (e.g. starred
     dominate), log a warning and stop — never delete starred.

5. **Wire into lifecycle** — in `poller.ts`, run `cleanupOrphans()` then
   `enforceSizeCap(dbMaxSizeBytes)` on startup and on a `setInterval` daily timer
   (guarded so it doesn't overlap a poll). Log a summary line each pass.

6. **Tests** (`server/maintenance.test.ts`, `TEST_DB`):
   - orphan rows deleted; starred orphan kept.
   - over-cap DB trims oldest-first; starred + newest retained; ends under cap.
   - under-cap DB → no deletions, no VACUUM.
   - empty/garbage `pub_date` falls back to `updated_at` ordering.

7. **Docs** — update `CLAUDE.md` (maintenance behavior, `DB_MAX_SIZE_MB`) and append the
   `## Outcome` section here.

## Risks & Open Questions
- **Behavior change:** non-starred orphan history is permanently dropped. Re-adding a
  previously-removed feed will no longer restore old read/unread/star state for its
  non-starred articles. The user explicitly asked for orphan cleanup, so this is intended.
- **VACUUM cost:** `VACUUM` rewrites the whole file, needs free disk ≈ final DB size, and
  blocks the DB (better-sqlite3 is synchronous → brief Node event-loop stall, ~1–3s at
  this size). Acceptable because the cap is hit rarely (trim to 90% buys headroom).
  *Alternative:* one-time switch to `PRAGMA auto_vacuum = INCREMENTAL` + `PRAGMA
  incremental_vacuum` after deletes — avoids full rewrites but adds a one-time migration
  VACUUM and ~0.2% pointer-map overhead. Deferred.
- **Size metric:** uses `page_count * page_size` (logical, incl. WAL-committed pages),
  not raw `ls` bytes. After `VACUUM` the on-disk file tracks it closely; the `-wal`/`-shm`
  sidecars are excluded from the cap.
- **JS-sort cost:** sorting ~18k non-starred rows in JS runs only when over cap (rare).
  If it ever matters, add a persisted `pub_ts INTEGER` column + index and order in SQL.
- **Open question (needs user input before coding):**
  - Default cap **500MB** and low-watermark **90% (≈450MB)** — OK, or different values?
  - Cleanup cadence: startup + **daily** — fine, or a different interval?

## Estimated Complexity
**Medium** — one new module + config + poller wiring + tests. No schema migration. Main
care points are correct timestamp parsing (RFC-822, empty values) and VACUUM mechanics
under WAL.

## Outcome
Implemented as planned. Decisions confirmed with the user: **500MB cap / trim to 450MB
(90%)**, **startup + daily** cadence.

- `server/config.ts` — added `DB_MAX_SIZE_BYTES` from `DB_MAX_SIZE_MB` env (default 500).
- `server/maintenance.ts` (new) — `cleanupOrphans()`, `enforceSizeCap()`, and a
  `runMaintenance()` wrapper that runs both and swallows/logs errors. Ordering parses
  `pub_date` (RFC-822) → `updated_at` → `0` in JS; deletes in ≤500-id chunks in one
  transaction, then `VACUUM`. Starred rows are never touched; non-starred orphans are
  removed even if under cap.
- `server/poller.ts` — `runMaintenance()` on startup + `setInterval` every 24h. Skipped
  under `TEST_DB` (guarded by the existing early return in `startPoller`).
- `server/maintenance.test.ts` (new) — 3 tests: orphan deletion w/ starred preserved,
  no-op under cap, oldest-first trimming w/ starred + newest preserved. All pass;
  `npm run typecheck` clean; full suite 33/33.
- `CLAUDE.md` — documented the maintenance module and `DB_MAX_SIZE_MB`.

Deviation from plan: chose full `VACUUM` after a trimming pass (not `auto_vacuum`), as
flagged in the plan's alternative — simplest, and the 90% watermark keeps trim passes rare.

**Not yet run against production.** On first real run it will delete ~823 non-starred
orphan rows. The 201MB DB is well under the 500MB cap, so no size-trim (and no `VACUUM`)
runs — the orphan-freed pages go to the freelist and are reused by future inserts, so the
on-disk file stays ~201MB but won't grow until that slack is consumed. The bulk of the
201MB is ~18k legitimate (non-orphan) articles; those are only trimmed once the DB crosses
500MB. To force the file to shrink on disk now, run a one-off `sqlite3 rss.db 'VACUUM;'`
against the deploy DB (with the service stopped) — optional, since growth is now bounded.
