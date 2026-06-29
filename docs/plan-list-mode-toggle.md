# Plan: 最新/摘要 list-mode toggle

## Goal
Give the merged multi-feed lists (`全部` / `今日`) a header toggle between two modes so a
high-volume feed can't crowd out slower ones:
- **最新 (latest)** — strict newest `LIST_LIMIT` (current behaviour, the default).
- **摘要 (digest)** — Option A per-feed quota: each feed contributes up to
  `ceil(LIST_LIMIT / feedCount)` of its newest articles, then the union is merge-sorted by
  publish time. Guarantees every feed is represented.

## Scope
- In: `/api/all-articles` + `/api/today` gain a `?mode=latest|digest` param; client gains a
  store flag, a header segmented toggle (desktop + mobile via shared `ArticleList`).
- Out: feed-specific list, starred, podcasts, search (single-source — fairness is meaningless).
  No schema change (`(feed_id, pub_ts)` index already exists). Mode is in-memory, default latest.

## Steps
1. Server `routes/articles.ts`: add `quotaFor(feedCount)`; both handlers read `mode`, pick
   per-feed SQL limit (`LIST_LIMIT` for latest, quota for digest).
2. Client `types.ts`: add `ListMode = 'latest' | 'digest'`.
3. Client `store.ts`: add `listMode` + `setListMode`; append `?mode=` for all/today; reload on switch.
4. `ArticleList.tsx`: render segmented toggle in header when `showModeToggle`.
5. `App.tsx` + `pages/ListPage.tsx`: wire props; `showModeToggle = all|today`.
6. fmt + lint + typecheck.

## Risks & Open Questions
- Digest is no longer strictly newest-first globally — that is the intended trade-off.
- `ceil` quota can slightly under-fill the list when feeds are sparse; acceptable for a digest.

## Estimated Complexity
Low–Medium — localized, no schema/migration.

## Outcome
Implemented as planned, no deviations.
- Server `routes/articles.ts`: `perFeedLimit(mode, feedCount)` helper; both `/api/all-articles`
  and `/api/today` read `?mode` and pick the per-feed SQL limit (`LIST_LIMIT` for latest/default,
  `ceil(LIST_LIMIT / feedCount)` for digest). Unknown/absent mode ⇒ latest.
- Client `types.ts` (`ListMode`), `store.ts` (`listMode` default `latest` + `setListMode`,
  `?mode=` appended for all/today, reload on switch), `ArticleList.tsx` (`ModeToggle` segmented
  control 最新/摘要 in the header, shown via `showModeToggle`), wired in `App.tsx` + `pages/ListPage.tsx`.
- Tests: new `server/test/list-mode.test.ts` (3 cases) proves a 600-item firehose crowds the slow
  feed out in latest mode but the slow feed is fully represented in digest mode; default ⇒ latest.
- Gates green: server 86 tests pass, client + server typecheck clean, fmt:check + lint clean.
- CLAUDE.md API table updated with the `?mode=` param.

### Follow-up: simplify the `latest` path
Per review, the per-feed flatMap+merge was unnecessary for `latest` (`article_id` is the global
PRIMARY KEY → no cross-feed dupes, so `dedupById` was dead). Changes:
- `latest`/default now a single global query: `SELECT * FROM article_states [WHERE pub_ts >= ?]
  ORDER BY pub_ts DESC LIMIT 500`, removing the ~feedCount×500 over-fetch.
- Added standalone index `idx_article_states_pub (pub_ts)` (db.ts migration) so the global order
  walks the index and stops at LIMIT — confirmed via EXPLAIN QUERY PLAN (no temp B-tree sort).
- `digest` keeps the per-feed quota + merge (served by the composite `(feed_id, pub_ts)` index).
- Removed the now-dead `dedupById` helper/export from `articles.ts`.
- Re-verified: 86 server tests pass, typecheck + fmt + lint clean.
