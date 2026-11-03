# Plan: page through search results (`before`, `cursor`, `total`)

## Goal

`/api/search` returns only the newest 100 matches. For a common term that is about one week
of articles (HBM: 1,773 matches since June, the 100th is a week old), so an agent asked about
"earlier" articles through `search_articles` never sees them and cannot tell how many exist.
Let a caller reach older matches and learn the total.

## Scope

In:
- `GET /api/search` gains three optional query params:
  - `before=<date>` — only articles published strictly before it (any format `ParsePubDate`
    takes, e.g. `2026-09-01`); invalid → 400.
  - `cursor=<pub_ts>_<article_id>` — keyset paging: the page after that row; invalid → 400.
  - `count=1` — adds `total`: every match for `q` + scope + `before`, ignoring the cursor.
    Opt-in because the count scans every row's text (~0.5 s on the 600 MB DB), while a page
    of a common term stops after 100 rows (~30 ms). The UI does not ask for it.
- The response always carries `next`: the cursor for the following page, or `null`.
- Order becomes `pub_ts DESC, article_id DESC` straight from SQL, 100 per page. The handler's
  re-sort by re-parsed `pub_date` goes: a cursor needs one total order, and `pub_ts` is what
  every other list (`NewestGlobal`, the per-feed lists) already orders by. The only rows that
  move are those with an unparseable `pub_date` (stored `pub_ts` = fetch time); they used to
  sink to the bottom of the 200-row window, now they sit at their fetch time like elsewhere.
- `search_articles` (MCP) gains `before` and `cursor`, always sends `count=1`.
- Docs: `CLAUDE.md` API table + MCP paragraph, `docs/backend-fetch-cache.md` row.

Out:
- UI paging ("load more" in the search pane). The UI keeps its first page; nothing there
  changes.
- FTS5 / ranking.

## Why a keyset cursor, not just `before`

`pub_ts` is not unique: 4,760 timestamps are shared, up to 24 rows on one (date-only feeds).
Paging by "strictly older than the last row's date" would drop the rest of a tie at every page
boundary; `(pub_ts, article_id)` is a total order, so nothing is skipped or repeated.

## Steps

1. `store.Search(r, like, SearchOpts)` with `Before`, cursor and `Limit`; `store.SearchCount`.
   Store tests: before, cursor across a `pub_ts` tie, count.
2. Handler: parse `before` / `cursor` / `count`, LIMIT 101 to detect `next`, drop the re-sort.
   HTTP tests: next/null, cursor paging, 400s, total only with `count=1`.
3. MCP tool params + test; docs.
4. `make check`, client `npm test` (search URL tests untouched), commit, deploy, live probe.

## Risks

- `pub_ts` is nullable in the schema; a NULL row is never reached through a cursor. Every
  write path sets it and production has none (checked).
- Rows arriving while paging shift nothing: the cursor is a position in the order, not an
  offset.

Complexity: Low–Medium.

## Outcome

Done as planned, 2026-11-03.

- `store.Search(r, like, SearchOpts)` returns `SearchHit`s (row + `pub_ts`); `store.SearchCount`
  shares its WHERE clause minus the cursor. Store tests cover `Before` and a cursor resuming
  inside a three-row `pub_ts` tie; HTTP tests page 205 rows (two per timestamp) as
  100 / 100 / 5 with no repeat, check `before` is exclusive, `total` only with `count=1`, and
  400s for a bad `before` or `cursor`.
- `before` takes what `ParsePubDate` takes: `2026-09-01` (local midnight) or a full ISO time;
  `2026-09` alone is rejected.
- `search_articles` gained `before` and `cursor` and always sends `count=1`.
- Added the missing `/api/search` row to the `CLAUDE.md` API table.
