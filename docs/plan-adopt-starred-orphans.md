# Plan: Re-adopt starred orphans on feed re-add

## Goal
`DELETE /api/feeds/:id` keeps starred articles but leaves their `feed_id` pointing at a
now-deleted feed (a dangling reference). The most-noticed consequence: deleting a feed and
re-adding the same URL mints a new `feed_id`, so the starred orphan never re-appears in the
re-added feed's per-feed list (`/api/feeds/:id/articles` filters by `feed_id`). This is the
"minimal fix" chosen by the user: keep delete behavior as-is, but make a re-added URL adopt
its own starred orphans. Requires a durable link from an article back to its feed URL, since
after delete the `feed_id` is dead and article rows carry no URL today.

## Scope
Included:
- `article_states.feed_url` column (+ backfill migration) so a starred row remembers which
  feed URL it came from even after the feed row is gone.
- Set `feed_url` on both insert paths (`persistItems` poll/refresh, `saveState` star).
- On feed add (`POST /api/feeds`) and OPML import, adopt orphaned starred rows for that URL
  into the new feed (`feed_id` + `feed_name` refreshed).

Out of scope (unchanged, per the chosen minimal option):
- Delete still keeps starred rows and hard-deletes the feed (no soft-delete/archive).
- Global-list behavior (All/Today latest vs digest, search, podcasts) is untouched — orphans
  still linger in `latest` while the feed stays deleted. Only re-add reconciles them.
- Pre-existing orphans whose feed was already deleted before this migration have no URL to
  backfill (their feed is gone), so they can't be adopted — an accepted one-time loss.

## Steps
1. **db.ts:** `ALTER TABLE article_states ADD COLUMN feed_url TEXT`; backfill existing rows
   from the live feed (`UPDATE ... SET feed_url = (SELECT url FROM feeds WHERE feeds.id =
   article_states.feed_id) WHERE feed_url IS NULL AND feed_id IN (SELECT id FROM feeds)`).
2. **articles.ts:** add `feed_url` to both upserts (insert-only, like `feed_id`/`feed_name` —
   not overwritten on conflict, so a live feed never re-homes an existing row). `persistItems`
   supplies `feed.url`; `saveState` derives it via a `(SELECT url FROM feeds WHERE id = ?)`
   subquery from the article's `feedId`. Update the stale "nothing to re-home" doc comment.
3. **articles.ts:** export `adoptStarredOrphans(feedId, feedName, url)` —
   `UPDATE article_states SET feed_id = ?, feed_name = ? WHERE feed_url = ? AND is_starred = 1
   AND feed_id NOT IN (SELECT id FROM feeds)` (same "orphan" idiom as maintenance.ts:23).
4. **routes/feeds.ts:** call `adoptStarredOrphans` after the INSERT in `POST /api/feeds` and
   for each newly-imported feed in `import-opml`.
5. **Tests:** star an article under feed A → delete A (orphan kept) → re-add A's URL → assert
   the starred article's `feed_id`/`feed_name` now match the new feed and it lists under
   `/api/feeds/:newId/articles`. Cover the OPML path too.
6. Update CLAUDE.md schema note (`feed_url` column); `npm run fmt`/`lint:fix`; server tests.

## Risks & Open Questions
- `saveState` subquery returns NULL if the feed row is absent (e.g. starring an already-
  orphaned article). Acceptable: such a row simply won't be adoptable, matching pre-existing
  orphans. Normal starring happens while the feed is live, so `feed_url` is populated.
- Adoption matches purely on `feed_url`; with the new `UNIQUE(feeds.url)` there is at most one
  live feed per URL, so the `feed_id NOT IN feeds` guard cleanly targets only orphans.

## Estimated Complexity
Low–Medium — one column + backfill, two upsert edits, one adopt query wired into two routes.

## Outcome
Implemented as planned, no deviations:
- `db.ts`: added `feed_url` column + backfill from the live feed for non-orphan rows.
- `articles.ts`: `feed_url` set insert-only in both upserts (`persistItems` → `feed.url`;
  `saveState` → `(SELECT url FROM feeds WHERE id=?)` subquery on the article's `feedId`);
  exported `adoptStarredOrphans(feedId, feedName, url)`; refreshed the stale doc comment.
- `routes/feeds.ts`: call `adoptStarredOrphans` after INSERT in `POST /api/feeds` and per
  imported feed in OPML import.
- `test/routes.test.ts`: end-to-end adoption test (star → delete → re-add via OPML →
  orphan re-homed + feed_name refreshed + queryable under new feed_id).
- CLAUDE.md schema/prose updated for `feed_url` + the adoption re-home path.
- `npm run fmt:check` + `npm run lint` clean; `cd server && npm test` → 95 pass, 0 fail.
