# Plan: Reading history (`最近阅读`) view

## Goal

Add a `最近阅读` smart-subscription view in the sidebar so recently opened articles are
easy to find again across devices, ordered by when each article was last opened and
capped to the most recent entries (default 200, up to 500 via `?limit=`).

## Scope

In:

- `last_opened_at INTEGER` column (epoch ms) on `article_states` + partial index
  `idx_article_states_opened ON article_states(last_opened_at DESC, article_id DESC) WHERE last_opened_at IS NOT NULL`.
- Record open timestamp inside existing `POST /api/current-article` via an `UPDATE`-only
  `store.TouchOpened` call (no new write endpoint, no duplicate client POST).
- `GET /api/history` (default limit 200, optional `?limit=1..500`, `?summary=1`), returning
  `{ articles: [...] }` without `content`.
- Client `'history'` view type, `FeedSidebar` nav item (`最近阅读` with `History` icon),
  `viewTitle` mapping, and skipping redundant `selectArticle` POST when re-clicking the
  already selected article.
- Go store/handler/migration tests + client unit tests.

Out:

- Separate `reading_history` side table or article snapshots (history rides on
  `article_states` like `starred_at` and `play_position`; deleted feeds and DB size-cap
  trimming naturally clean up unstarred rows).
- Extra `POST /api/articles/:id/open` endpoint, client write queues, or error banners.
- `lastOpenedAt` wire field on `Article`, custom `"X 分钟前打开"` row time formatting, or
  a `"最近 200 篇"` header subtitle (ordering alone communicates recency, matching `收藏`).
- Live list reordering while browsing inside `最近阅读` (the list updates on view entry or
  explicit refresh so keyboard ArrowUp/ArrowDown and mobile back stay stable).
- Read/unread state, dwell-time thresholds, or backfilling historical opens.

## Design decisions

**One column on `article_states`, not a side table.** Like `starred_at`
(`docs/plan-starred-sort.md`) and `play_position` (`docs/plan-podcast-progress-sqlite.md`),
last-opened time is per-article metadata that is meaningless once the article row is gone.
`SaveState` and `PersistItems` use explicit column lists on conflict, so feed refreshes and
star toggles automatically preserve `last_opened_at`.

**Piggyback on `POST /api/current-article`, `UPDATE` only.** Every article open (desktop
click, mobile click, ArrowUp/ArrowDown, push deep link) already goes through
`selectArticle` and fires `POST /api/current-article`. Having `postCurrentArticle` extract
`id` from `body.Article` and run `UPDATE article_states SET last_opened_at = ? WHERE article_id = ?`
avoids a second network request on every click. As with `SavePlaybackProgress`, 0 rows
affected is a silent no-op so a stale or trimmed id never mints a title-less row.

**Reuse `articleColsNoContent` and `ArticleList` unchanged.** `store.History(db, limit)`
selects `articleColsNoContent` ordered by `last_opened_at DESC, article_id DESC LIMIT ?`
and scans through `scanArticleRows`. Neither `model.Article` nor `ArticleList` row
rendering needs a new timestamp field or formatter.

## Steps

1. **Schema** (`server-go/internal/db/db.go`) — add idempotent
   `ALTER TABLE article_states ADD COLUMN last_opened_at INTEGER` and partial index
   `idx_article_states_opened`. Cover in `internal/db/migrate_test.go`.
2. **Store** (`server-go/internal/store/store.go`, `write.go`) — add
   `TouchOpened(w *sql.DB, id string, now int64) error` (`UPDATE`-only) and
   `History(r *sql.DB, limit int) ([]articles.Row, error)` using `articleColsNoContent`.
3. **HTTP API** (`server-go/internal/httpapi/httpapi.go`) — in `postCurrentArticle`, stamp
   `TouchOpened` when the payload carries a non-empty `id`; add `GET /api/history` with
   default limit 200 (`?limit=1..500`, 400 on invalid value, `?summary=1` support) and
   register in `mountAPIRoutes`.
4. **Client** (`client/src/types.ts`, `store.ts`, `viewTitle.ts`,
   `components/FeedSidebar.tsx`) — add `'history'` to `View['type']`, map `history` to
   `${API}/history` in `loadArticles`, guard `selectArticle` against re-posting when
   `selectedArticle?.id === article.id`, add `'history' → '最近阅读'` to `viewTitle`, and
   add a `最近阅读` `NavItem` (`History` icon) in `FeedSidebar.tsx`.
5. **Tests & docs** — Go store + handler tests (`store_test.go`, `write_test.go`), client
   `store.test.ts` + `viewTitle.test.ts`, and update `CLAUDE.md` schema/view/API tables.

## Risks & open questions

- **History follows article retention.** Deleting a feed or hitting the 2GB DB size cap
  removes unstarred articles and their history entries; starred articles survive.
- **No backfill.** `last_opened_at` starts NULL for all existing rows and populates as
  articles are opened after deployment.

## Complexity

Low — one nullable column + partial index, one store read + one `UPDATE` wired into the
existing `postCurrentArticle` handler, and a standard sidebar view entry.

## Outcome

Implemented as planned, no deviations:

- `server-go/internal/db/db.go`: added idempotent `last_opened_at INTEGER` column on
  `article_states` and partial index `idx_article_states_opened` (`(last_opened_at DESC,
  article_id DESC) WHERE last_opened_at IS NOT NULL`); asserted in
  `internal/db/migrate_test.go`.
- `server-go/internal/store/{store,write}.go`: added `TouchOpened` (`UPDATE`-only, silent
  no-op on missing id) and `History` (`articleColsNoContent`, ordered by
  `last_opened_at DESC, article_id DESC LIMIT ?`); tested in `internal/store/store_test.go`.
- `server-go/internal/httpapi/httpapi.go`: `postCurrentArticle` stamps `TouchOpened` when
  `article.id` is non-empty; added `GET /api/history` (default limit 200, `?limit=1..500`,
  `?summary=1`); tested in `internal/httpapi/write_test.go`.
- `client/src/{types,store,viewTitle}.ts` + `components/FeedSidebar.tsx`: added `'history'`
  view (`最近阅读`), mapped to `/api/history`, guarded `selectArticle` against redundant
  POSTs when re-selecting the active article, and added tests in `store.test.ts` and
  `viewTitle.test.ts`.
- Verified: `cd server-go && make check`, `cd client && npm test && npm run typecheck`,
  and root `npm run fmt:check && npm run lint` all pass clean.

