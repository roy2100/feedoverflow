# Plan: Sort the starred list by star-action time

## Goal
The starred (收藏) list currently sorts by article publish date (`ORDER BY pub_ts DESC`),
so starring an old article buries it. Change the sort to newest-starred-first, matching
read-later tools, by recording when each article was starred and ordering on that.

## Scope
- Included: new `starred_at` column (epoch ms) + backfill, star write sets it, `Starred()`
  query orders by it, a partial index to keep the read index-only, and tests.
- Out of scope: unstar does not clear `starred_at` (harmless — ignored while not starred);
  the badge count query is unchanged; UI is unchanged (server owns the order).

## Steps
1. Migration (`internal/db/db.go`): `ALTER TABLE article_states ADD COLUMN starred_at INTEGER`
   (metadata-only, no row rewrite). Backfill existing starred rows from `updated_at`
   (`strftime`→ms), falling back to `pub_ts`. Replace the `idx_article_states_starred`
   partial index (currently keyed on `pub_ts`) with one keyed on `starred_at DESC` — it
   serves both the ordered list and the `is_starred = 1` count index-only.
2. Star write (`internal/store/write.go`, `SaveState`): add `starred_at` to the INSERT and
   `ON CONFLICT` — set it to `now` when `is_starred` becomes 1, otherwise keep the existing
   value. `SaveState` is the *only* star-toggle path (refresh uses `PersistItems`), so this
   never fires on a background re-fetch.
3. Query (`internal/store/store.go`, `Starred`): `ORDER BY starred_at DESC`. Invariant after
   backfill: `is_starred = 1 ⟹ starred_at NOT NULL`, so the plain order is index-friendly.
4. Test (`internal/store/write_test.go`): starring stamps `starred_at`; re-starring after a
   later `now` moves it to the top; unstar leaves the column untouched.

## Risks & Open Questions
- `updated_at` is polluted by content re-fetches, which is exactly why we add a dedicated
  column rather than reusing it. Backfill uses it only as a one-time best-effort seed.
- Dropping/recreating the starred partial index runs on every startup via IF-guards; must be
  idempotent and cheap.

## Estimated Complexity
Low — one migration, two query touch points, one test.

## Outcome
Implemented as planned.
- `internal/db/db.go`: added `starred_at INTEGER` (idempotent ALTER), a one-time backfill
  (`COALESCE(strftime→ms, pub_ts, 0)` for `is_starred = 1 AND starred_at IS NULL`), and
  swapped `idx_article_states_starred` from `(pub_ts)` to `(starred_at DESC)` via
  `DROP INDEX IF EXISTS` + `CREATE INDEX IF NOT EXISTS` so existing DBs pick up the new key.
- `internal/store/write.go`: `SaveState` stamps `starred_at = now` when `is_starred` flips to
  1, preserves it otherwise. Confirmed `SaveState` is the sole star-toggle path.
- `internal/store/store.go`: `Starred()` now `ORDER BY starred_at DESC`.
- Tests: added star-action stamping (star/unstar/re-star), star-action ordering vs. inverted
  pub dates, and a migration backfill + re-run-idempotency test on a populated DB; updated the
  existing `TestStarredAndCount` to assert the new `starred_at` order. `make check` clean.
- No client change: `store.ts` renders the server order verbatim (no re-sort). Badge count is
  unchanged and still served index-only by the swapped partial index.
- Deviation: none. Deploy note — the migration runs automatically at next server start
  (`InitSchema`); the index swap + backfill are one-time and cheap over the small starred set.
