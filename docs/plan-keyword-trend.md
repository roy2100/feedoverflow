# Plan: Keyword trend (关键词热度曲线)

## Goal

Answer "how much has *X* been talked about lately, and when did it spike?" — e.g. `Muse` —
as a daily article-count chart over the last 7 / 30 / 90 days, with the articles behind any
bar one click away. This is the "offline stats/research" use the full-history
`article_states` was kept for; it needs no new data, only a new read.

## Key premises (measured on the live DB, 2026-09-30)

- 128,866 rows, 71 feeds. Real volume starts **2026-06** (~30k/month since); earlier months
  hold only ~100 backfilled rows each. So 90 days is the useful ceiling today — longer ranges
  would draw a cliff that is an artifact of when persistence began, not of the topic.
- `LIKE` over title/summary on 90 days, served by `idx_article_states_pub`: **~0.08–0.16 s
  warm** (0.47 s with `content` added). No FTS, no new index, no pre-aggregated table.
- Substring matching is not good enough for Latin keywords: of 407 `LIKE '%muse%'` hits in 90
  days, **43 are `museum` / `amuse`**. The collections word-boundary pass (`wordBoundary` in
  `internal/store/collections.go`) already solves exactly this and is reused.
- `title_zh` is populated only from **2026-08-05** (when translation was switched on). Matching
  it would put a step into every CJK keyword's curve on that date — see Decision 2.

## Scope

**In**
- `GET /api/trend` — daily buckets + the matching articles.
- A 趋势 tab in the search view: SVG chart pinned above the list; clicking a bar narrows the
  list to that day.
- `|` inside a query as OR-synonyms for one series (`Muse|缪斯`).
- MCP tool `get_keyword_trend` (14th tool).

**Out (v1)**
- Several series on one chart (Muse vs Grok). The API takes one series per call, so the
  client can add this later by calling it twice.
- Saved / pinned trend keywords, trend for a collection's rules, scoped (per-feed) trends.
- Hour-level buckets, ranges beyond 90 days, any cached aggregate.

## Decisions

1. **Match semantics = collections', not search's.** Keywords match `title` + `summary`, never
   `content`. Measured for `muse`, 90 days: `content` adds 17 hits to 407 (+4%) at 3× the query
   time (0.47 s vs 0.16 s) — cost is not the reason. The reason is what those 17 are: most are
   **markup** (`<img alt>`, `data-caption="Muse Group"`, `Zenmuse`, `…-museum-…` and
   `meta-muse-spark` inside `href`s — a hyphen is a word boundary, so the whole-word pass cannot
   reject them), or **one line in a 44k–110k-char digest** (HackerNews每日摘要, Lenny's), which
   would count the same as an article *about* Muse. A few are genuine in-body mentions
   (ABMedia) and are lost; accepted. ASCII keywords are whole-word (SQL `LIKE` coarse pass, Go `wordBoundary` re-check); CJK
   keywords are substring. Consequence: the 趋势 list can differ from the 结果 list for the same
   query. That is intended — the list under a chart must be exactly the rows the bars counted.
2. **`title_zh` is not matched.** A trend's value is its shape over time, and `title_zh` coverage
   itself changes over time (none before 2026-08-05, only the last 24h at switch-on). Matching it
   would draw that coverage change as a topic change. The cross-language case is covered by
   Decision 3 instead: `英伟达|Nvidia`.
3. **`|` means OR within one series.** Split on `|`, trim, drop empties, max 5 terms. SQL ORs the
   `LIKE`s; the Go pass keeps a row if any term's matcher accepts it. No other operators.
4. **Count = articles, not stories.** The same event covered by 6 feeds counts 6. That is what
   "热度" means here (coverage volume); dedupe by `article_id` only.
5. **Buckets are local calendar days**, computed in Go with `time.Local` (the Mac's zone — the
   same basis as `/api/today`'s midnight). Dense and zero-filled, oldest → newest, today last
   and partial. Window: `pub_ts >= midnight(today − days + 1)` and `pub_ts <= now` (a
   future-dated item must not land in a bucket that doesn't exist yet — same rule as the push
   watermark).
6. **Each bucket also carries the day's `total`** (all articles). Subscriptions grew a lot since
   June, so a rising raw count can just mean more feeds. The chart plots raw counts (what was
   asked for); the tooltip adds 占当日 x%. No normalization toggle.
7. **Bars + 7-day average line.** Daily counts are discrete and often zero, so bars are the
   honest form; the "curve" is a trailing 7-day mean drawn over them (only for 30/90 days — on a
   7-day range it would be one point). Today's bar is drawn lighter and labelled 进行中.
8. **Bar click refetches, never filters client-side.** The list is capped (500), so a popular
   keyword's older days may not be loaded. `?day=YYYY-MM-DD` narrows `articles` to that day on
   the server — exact for every bar, one ~0.1 s local query.
9. **No chart library.** One hand-written SVG component; the client stays at 4 runtime deps.

## API

`GET /api/trend?q=Muse|缪斯&days=30[&day=2026-09-29][&limit=500]`

- `q`: required after trim, else 400. `days` ∈ {7, 30, 90}, else 400. `day` must be inside the
  window, else 400. `limit` 1–500, default 500.

```json
{
  "query": "Muse|缪斯",
  "days": 30,
  "matched": 364,
  "buckets": [
    { "date": "2026-09-01", "count": 0, "total": 1012 },
    { "date": "2026-09-30", "count": 12, "total": 403 }
  ],
  "articles": [ /* model.Article, newest first, no summary/content — same shape as /api/today */ ]
}
```

`matched` is the sum of `count` over the window (so the header can say "30 天 364 篇" even when
`articles` is capped or narrowed by `day`).

## Steps

1. **Store** (`internal/store/trend.go`): `TrendRows(r, terms, since, until)` — one static query
   `SELECT articleColsNoContent … WHERE pub_ts BETWEEN ? AND ? AND (title LIKE ? OR summary LIKE ?
   …)`, then the word-boundary refine. Generalize `refine` / `wordBoundary` to take a term list
   (any-of) rather than copying them. `DayTotals(r, since, until)` — `SELECT pub_ts` over the
   index, bucketed in Go by the same function the matches use.
2. **Handler** (`internal/httpapi/trend.go`): parse/validate, build buckets, apply `day` + `limit`
   to the article slice, respond. Register on both routers (shared handler list).
3. **Tests**: word boundary (`Muse` ≠ `museum`, `版Muse` matches), `|` terms, zero-filled dense
   buckets, today partial, future-dated row excluded, local-midnight boundary, `day` narrowing,
   `matched` independent of `limit`, 400s, response has no `summary`/`content`.
4. **Client types/store**: `View` gets `{ type: 'trend', query, days }`; `loadArticles` branch
   fetches `/api/trend`, sets `articles` and a new `trend: { buckets, matched, day? }` slice.
   Switching 结果 ⇄ 趋势 keeps the query.
5. **`TrendChart.tsx`**: SVG, width from the list column (380 desktop / full width mobile), ~120px
   tall. Y gridlines at 0 and max only; x labels first / middle / last date; bars in
   `--accent`, average line in `--text-secondary`. One pointer handler on the whole plot picks the
   nearest bar by x — at 90 days a bar is ~4px wide, too small to hit on a phone. Hover/tap
   tooltip: `9月29日 · 32 篇 · 占当日 3.1%`. Selected bar highlighted; list header shows a
   `9月29日 ×` chip to clear. Range chips 7天 / 30天 / 90天 at the chart's top-right.
   (Load the `dataviz` skill before writing it.)
6. **ArticleList**: in search/trend views the header shows a `结果 | 趋势` toggle (reuse
   `ModeToggle`); in trend view, `TrendChart` renders pinned between header and list. Empty
   state: "近 30 天没有提到 Muse 的文章". Mobile gets it for free via `ListPage`.
7. **MCP**: `get_keyword_trend { query, days }` → `/api/trend?…&limit=30` — buckets for the
   shape, 30 newest headlines to explain it. Update the tool count in `CLAUDE.md`.
8. **Docs**: CLAUDE.md API table + a short "Keyword trend" server bullet pointing here.
9. `make check`, `npm test`, `npm run typecheck`, `fmt:check`, `lint`; manual test steps; deploy.

## Risks / open questions

- **Search-scope toggle doesn't apply to trends** (v1 is always all feeds). If scoped search is
  on, the 趋势 tab should say 全部订阅源 so the difference is visible, not silent.
- **`summary` quality varies by feed** — some ship the full body as summary, some nothing. A feed
  that puts the body in `summary` over-contributes mentions. Accepted for v1; per-feed breakdown
  in the tooltip is the natural follow-up if it distorts real curves.
- **Timezone of a phone abroad**: buckets are server-local days. Single-user, same zone — fine,
  but the client never re-buckets, so at worst labels are off by a day, never counts.
- **One-character ASCII keywords** (`X`) will match whole-word `X` everywhere. Not blocked;
  the curve will just be noisy.

## Complexity

**Medium** — one read endpoint reusing existing matching, one SVG component, one MCP tool. No
schema change, no background job, no migration.

## Outcome

Shipped as planned: `GET /api/trend`, the 结果 | 趋势 toggle with a pinned SVG chart, `|`
synonyms, and `get_keyword_trend` (14th MCP tool). No schema change.

Deviations:
- **Per-term fan-out instead of a generalized matcher.** `store.TrendHits` runs one static query
  per term and applies that term's `wordBoundary`; the handler merges by `article_id`. Same shape
  as `RuleArticles`, so `refine`/`wordBoundary` needed no change. `scanArticleRows` gained a
  `scanArticleRow(rows, r, extra...)` helper so the query can select `pub_ts` after the usual
  columns.
- **The tooltip follows the pointer only.** A selected day is spelled out in a chip under the
  chart (`9月29日 周二 · 34 篇 ×`); a pinned tooltip would sit over the bars. On a phone the tap
  selects and the chip carries the numbers.
- The segmented control was lifted out of `ArticleList` into `components/Segmented.tsx`, shared by
  最新/摘要, 结果/趋势 and the 7/30/90 range picker.
- A query typed into the sidebar while on 趋势 stays on 趋势 (keeping the range). Switching tabs
  back and forth resets the range to 30 — the chart state is dropped outside the trend view.

Measured on a copy of the live DB (2026-09-30), whole round-trip through the handler:

| Query | 30 days | 90 days | matched (90d) |
|---|---|---|---|
| `Muse` | 0.07 s | 0.18 s | 352 (vs 407 with plain `LIKE`) |
| `AI` | 0.14 s | 0.35 s | 14,852 (list capped at 500) |
| `英伟达\|Nvidia` | 0.15 s | 0.39 s | 2,448 |
