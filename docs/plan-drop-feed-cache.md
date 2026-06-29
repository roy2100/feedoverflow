# Plan: Drop `feed_cache`, track per-feed fetch time

## Goal
`feed_cache.items_json` duplicates list metadata that already lives in `article_states`
(both are written in the same `refreshFeed` transaction). The only unique thing the table
provides is `fetched_at` (TTL/refresh scheduling). Replace the whole table with a per-feed
`last_fetched_at` timestamp and serve all list endpoints directly from `article_states`,
removing the redundant store and its body-stripping/serialization overhead.

## Scope
Included:
- Drop `feed_cache` table, `clearCache`, `FeedCacheRow`.
- Add `feeds.last_fetched_at INTEGER` (freshness) and `article_states.pub_ts INTEGER`
  (sortable publish time) + index `(feed_id, pub_ts)`.
- Backfill `pub_ts` from existing `pub_date` on migration.
- Rewrite `cache.ts`: `refreshFeed` records `last_fetched_at`; replace `getCachedFeed`
  with `ensureFresh` (trigger refresh by freshness; await only a truly cold feed).
- Serve `/api/feeds/:id/articles`, `/api/all-articles`, `/api/today` from `article_states`.
- Add shared `rowToArticle` mapper; reuse in starred/podcasts too.
- Update tests + CLAUDE.md.

Out of scope:
- `maintenance.ts` stays on its JS `pub_date` sort (don't expand blast radius; its test
  inserts rows without `pub_ts`).
- Client changes (API shapes unchanged).

## Steps
1. `dates.ts` — extract pure `parsePubDate` so `db.ts` can backfill without a cycle
   (`articles.ts` re-exports it; `maintenance.ts`/routes keep importing from `articles.ts`).
2. `db.ts` — add columns + index (idempotent `ALTER`), backfill `pub_ts` where NULL, drop
   `feed_cache` table.
3. `types.ts` — `Feed.last_fetched_at?`, `ArticleStateRow.pub_ts?`, remove `FeedCacheRow`.
4. `articles.ts` — `persistItems`/`saveState` write `pub_ts`; add `rowToArticle`.
5. `cache.ts` — `refreshFeed` updates `last_fetched_at`; `ensureFresh`; rewrite warming.
6. `routes/feeds.ts`, `routes/articles.ts` — read from `article_states`.
7. `routes/settings.ts` — drop `clearCache.run()` (no cache to bust; refresh keys off TTL).
8. Tests — `content.test.ts` seeds `last_fetched_at` instead of `feed_cache`.
9. CLAUDE.md — update table list, data-flow, cache notes.
10. `npm run fmt && npm run lint:fix`, `npm test`.

## Risks & Open Questions
- **Frozen-at-first-seen metadata**: `persistItems` is `INSERT OR IGNORE`, so list rows no
  longer reflect upstream edits. Accepted in prior discussion (RSS rarely mutates; matches
  how historic rows already behaved).
- **Cold vs migrated feeds**: after deploy, existing feeds have NULL `last_fetched_at` but
  have rows → must background-refresh (non-blocking), not block. `ensureFresh` distinguishes
  via a `SELECT 1 ... LIMIT 1` existence check only when no fetch was ever recorded.
- **`today` and unparseable dates**: `pub_ts` falls back to fetch time, so date-less items
  count as "recent" (minor behavior shift from the old `?? 0` exclusion).

## Estimated Complexity
Medium — one table dropped, two columns + backfill, cache layer rewrite across 3 endpoints,
but API shapes and the persist chain invariants are preserved.

## Outcome
Done as planned. `feed_cache` is dropped; freshness lives in `feeds.last_fetched_at` and all
list endpoints read from `article_states`, ordered by the new sortable `pub_ts` column
(`(feed_id, pub_ts)` index), backfilled on migration. `parsePubDate` was extracted to a
cycle-free `dates.ts` (re-exported from `articles.ts`); a shared `rowToArticle` mapper now
backs `feeds/:id/articles`, `all-articles`, `today`, `starred`, and `podcasts`. `getCachedFeed`
→ `ensureFresh`; `clearCache` replaced by nulling `last_fetched_at` on settings change.

Deviations from the plan:
- `maintenance.ts` left untouched as planned (still JS-sorts on `pub_date`).
- No `Article` import needed in `routes/articles.ts` anymore (mapper centralizes it).

Verification: `tsc --noEmit` clean, `npm run fmt:check`/`lint` clean, 82/82 offline server
tests pass. Live `*.itest.ts` not run (network). Client untouched (API shapes unchanged).
