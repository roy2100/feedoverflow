# Plan: Prevent duplicate feed URLs

## Goal
The same RSS URL can currently be added multiple times via `POST /api/feeds`, because
that route mints a fresh `crypto.randomUUID()` and inserts unconditionally — there is no
duplicate check and no `UNIQUE` constraint on `feeds.url`. Duplicate feed rows are not just
cosmetic: `article_states.article_id` is a global PK and `persistItems` sets `feed_id`
only on insert, so the same URL's articles get owned by whichever duplicate fetched first;
the other duplicate reads its own `feed_id` and shows an empty feed, delete purges articles
out from under the sibling, and the poller re-fetches the same upstream once per row. This
change makes feed URLs unique, matching the dedup the OPML import path already performs.

## Scope
Included:
- Schema-level uniqueness on `feeds.url` (unique index) + a migration that collapses any
  pre-existing duplicate rows first, re-homing their articles onto the surviving row.
- Route-level guard in `POST /api/feeds` returning a friendly 409 instead of a raw SQLite
  constraint error.
- Tests for the new behavior.

Out of scope:
- Deduping `rsshub://` shorthand against its hand-expanded form. Dedup keys on the raw
  stored `url` (as OPML import already does); resolving via the mutable `rsshub_base_url`
  setting would make the comparison depend on a setting that can change between adds.
- The starred-orphans issue (tracked separately) — the collapse migration re-homes rather
  than deletes, so it does not worsen it.

## Steps
1. **db.ts migration (before the unique index):** find URLs with >1 feed row. For each,
   keep the oldest row (min `rowid`) as the winner; `UPDATE article_states SET feed_id =
   winner, feed_name = winnerName WHERE feed_id = loser` for each loser, then delete loser
   feed rows. Run inside a transaction. This preserves every article (incl. starred) under
   one feed instead of stranding them.
2. **db.ts unique index:** `CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_url ON feeds(url)`.
   Uses an index rather than rebuilding the table (SQLite can't `ALTER TABLE ADD CONSTRAINT`).
   Must run after step 1 so it cannot fail on existing dupes.
3. **feeds.ts route guard:** in `POST /api/feeds`, before insert, `SELECT id FROM feeds
   WHERE url = ?`; if present, return `409 { error: '该 Feed 已存在' }`. Keeps the raw
   constraint error from reaching the client and gives a clear message (store.ts surfaces
   `data.error`).
4. **Tests:** duplicate add returns 409 and does not create a second row; distinct URLs
   still add. Verify existing suites pass.
5. `npm run fmt` + `npm run lint:fix`, then `fmt:check` + `lint` clean; run server tests.

## Risks & Open Questions
- Collapse migration runs once on the live DB. Re-homing is idempotent and guarded by the
  duplicate scan, so re-running is a no-op. Low risk.
- A race between two concurrent adds of the same new URL could still both pass the SELECT
  check; the unique index is the backstop (the second INSERT throws). The route wraps the
  insert so the constraint error becomes a 409 rather than a 500 — handle that path too.

## Estimated Complexity
Low–Medium — the collapse migration is the only fiddly part; the guard and index are small.

## Outcome
Implemented as planned, no deviations:
- `db.ts`: added a transactional collapse migration (keep min-`rowid` row per URL, re-home
  losers' `article_states` via `feed_id`/`feed_name` update, delete loser rows) followed by
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_url ON feeds (url)`.
- `routes/feeds.ts` `POST /api/feeds`: early `SELECT` guard returns `409 { error: '该 Feed
  已存在' }` before the network parse; the `INSERT` is wrapped to translate a racing
  `SQLITE_CONSTRAINT_UNIQUE` into the same 409 instead of a 500.
- `test/routes.test.ts`: added a 409 dedup test asserting no second row is created.
- `npm run fmt:check` + `npm run lint` clean; `cd server && npm test` → 94 pass, 0 fail.
