# Plan: Article Search (title / summary / content)

## Goal
Add a search feature that lets the user find articles by matching a query against the
article **title**, **summary**, and **full body content**. Results render in the existing
middle article-list panel as a new `View` type, reusing the current list/reader UX. The
feature is keyboard-reachable from the sidebar and works on both desktop and mobile.

## Scope

### Included
- A backend `GET /api/search?q=...` endpoint that searches across all currently
  available articles (cached live feed items + persisted `article_states`).
- Matching against `title`, `summary`, and `content` (case-insensitive substring).
- A new client `View` of `{ type: 'search', query }`, wired through `store.ts`.
- A search input in `FeedSidebar` (desktop) and a search entry point for mobile.
- Debounced querying, result count, empty/no-result states, and result highlighting of
  the matched term in the list.

### Out of scope
- Full-text ranking / relevance scoring beyond simple recency sort.
- Fuzzy matching, stemming, boolean operators, or per-field search syntax.
- Searching articles that are **not** in the cache and **not** persisted (i.e. old
  unread items that have aged out of the 5-min feed cache and were never read/starred —
  their body was never stored). See Open Questions.
- Search history / saved searches.

## Data sources (why this is the crux)
Searchable text lives in two places, and the body (`content`) coverage differs:

1. **`feed_cache.items_json`** — fresh RSS items for every feed (5-min TTL). Contains the
   **full body** (`contentEncoded` / `content`) for *every* cached item, read or not.
   This is the primary source for body search of current articles.
2. **`article_states`** — persisted rows. **Correction (verified in `poller.ts`):** the
   background poller calls `persistPolled(..., { withContent: true })` every 15 min and
   `INSERT OR IGNORE`s the full **body** for up to 50 items per feed — *regardless* of
   read/starred. So bodies are already persisted for the bulk of recent history, not just
   read/starred items. Read/star additionally guarantee retention (starred is never
   evicted by the size cap). The only gaps: items beyond the per-feed 50 that were never
   read, and rows evicted by `DB_MAX_SIZE_MB` (non-starred only).

The search endpoint unions both, dedups by `article.id` (same `makeId` scheme), and
filters in JS. This mirrors the existing `/api/all-articles` enrich-from-cache pattern,
so no new index or schema migration is required.

**Rejected alternative — SQLite FTS5:** an FTS5 virtual table over `article_states` would
only index read/starred bodies (the same rows we already have), so it would *not* improve
body coverage for unread articles, while adding a migration + index-maintenance burden.
Defer FTS5 until/unless we decide to persist every fetched article's body (a much larger
change). Documented here so the decision is explicit.

## Steps

1. **Server — search helper (`server/app.ts`, reuse `articles.ts`).**
   Add `GET /api/search`:
   - Read and trim `q` from query string; if empty or `< 2` chars, return
     `{ articles: [] }`.
   - Gather candidates: for each feed, `getCachedFeed` + `enrich(items, …, { withContent: true })`
     (full body needed to match content), across all feeds via `Promise.allSettled`
     (same shape as `/api/all-articles`, but no `.slice` cap so the whole cache is searched).
   - Also pull `article_states` rows (map to `Article`, same as `/api/starred`) to cover
     historic/starred items not in the cache.
   - `dedupById([...live, ...persisted])`.
   - Filter: lower-case the query; keep an article if `title`, `summary`, or `content`
     contains it. Match against a stripped-tags copy of `content` so HTML markup doesn't
     produce false hits (small helper: `text.replace(/<[^>]+>/g, ' ')`).
   - Sort by `pubDate` desc, cap results (e.g. 100) to bound payload size.
   - Respond `{ articles, query }`. Honor request-abort like the other list endpoints.

2. **Server tests (`server/*.test.ts`).**
   Add a `search.test.ts` (or extend an existing suite) seeding feeds + cached items +
   a starred persisted row, asserting: title-only match, summary-only match,
   content-only match, case-insensitivity, `q` too short → empty, and dedup between
   cache and `article_states`.

3. **Client types (`client/src/types.ts`).**
   Extend `View`: `type: 'all' | 'today' | 'starred' | 'feed' | 'search'` and add an
   optional `query?: string`. Mirror in `server/types.ts` only if `View` is shared there
   (it is client-only today — confirm and skip server change if so).

4. **Client store (`client/src/store.ts`).**
   - In `loadArticles`, add a branch for `view.type === 'search'` that fetches
     `${API}/search?q=${encodeURIComponent(view.query)}` (through the existing
     `apiFetch` + AbortController flow — search benefits most from the existing
     abort-on-new-request behavior).
   - Add a `search(query: string)` action that sets
     `selectedView = { type: 'search', query }` and calls `loadArticles`. Empty query
     should fall back to the previous view or `today` (decide: clearing the box exits
     search).

5. **Client UI — desktop search box (`client/src/components/FeedSidebar.tsx`).**
   - Add a search `<input>` below the header (above "智能订阅"), with a `Search` icon
     from `lucide-react`, styled with the existing CSS variables.
   - Debounce input (~250ms) before calling `onSearch`; show a clear (✕) button when
     non-empty. Wire a new `onSearch` prop from `App.tsx` → `store.search`.
   - When `selectedView.type === 'search'`, none of the nav items appear selected
     (already true since the guard checks specific types).

6. **Client UI — result list affordances (`client/src/components/ArticleList.tsx`).**
   - Show a header reflecting the search (e.g. `搜索 "<query>" · N 条结果`) and an empty
     state when zero results.
   - Optional: highlight the matched substring in title/summary (wrap matches in a
     `<mark>`-styled span). Keep it simple; skip if it complicates the existing renderer.

7. **Client UI — mobile (`client/src/pages/`, `App.tsx`).**
   - Provide a mobile entry point: a search field at the top of `FeedsPage` (mobile
     sidebar) that, on submit, routes to the list page showing search results. Reuse the
     same `store.search` action so behavior is identical to desktop.

8. **Lint, format, typecheck, manual check.**
   - `npm run fmt && npm run lint:fix`, then `npm run fmt:check && npm run lint`.
   - `cd client && npm run typecheck`.
   - `npm run dev`, verify: title match, summary match, body match (read an article first
     so its body is persisted, or rely on cached body), clearing the box exits search,
     mobile path works.

## Risks & Open Questions
- **Body coverage gap (resolved — no extra work needed):** Initially flagged as needing
  permanent body persistence, but the poller already persists bodies (see corrected Data
  sources §2). Coverage is the union of persisted `article_states` (SQL `LIKE`) + the live
  cache (JS filter), which is comprehensive for a single-user reader. FTS5 stays deferred.
- **Performance:** Searching iterates all cached items + all `article_states` in JS per
  request. Fine for a single-user, hundreds-to-low-thousands article scale; revisit (FTS5)
  only if the DB grows large.
- **Highlighting + HTML:** Summaries/content can contain HTML; tag-stripping is needed
  for both matching and any highlight rendering to avoid breaking markup.
- **Min query length / debounce:** Picking 2 chars + 250ms is a guess; tune during the
  manual check.

## Estimated Complexity
**Medium** — one new backend endpoint reusing existing enrich/cache helpers (low risk),
a small store/`View` extension, and UI work across desktop sidebar + mobile + list panel.
No schema migration. The main open decision (permanent body persistence) is deferred and
gated behind a user question rather than blocking the core feature.

## Outcome
Implemented as planned, no schema migration. Deviations from the original plan:
- **Body persistence question dropped** — verified the poller already persists bodies, so
  the union of `article_states` (SQL `LIKE`) + live cache (JS filter) is sufficient. FTS5
  not needed.
- **Persisted path uses SQL `LIKE`** (escaped, `LIMIT 200`) instead of loading all rows
  into JS — efficient and bounded; minor HTML-tag false positives accepted for raw
  `content`. Live cache path strips tags before matching.
- **Result highlighting (step 6) skipped** for v1 to avoid touching the list renderer; the
  list shows a `搜索：<query>` title and the existing empty state. Can be added later.
- **Desktop = debounced live search (250ms); mobile = submit-on-Enter** then navigate to
  the list pane (avoids the sidebar sliding away mid-typing). Clearing the box (or a
  <2-char query) falls back to the Today view.

Files touched: `server/app.ts` (+`GET /api/search`), `server/search.test.ts` (new, 6
tests), `client/src/types.ts`, `client/src/store.ts`, `client/src/components/FeedSidebar.tsx`,
`client/src/App.tsx`, `client/src/pages/FeedsPage.tsx`, `client/src/pages/ListPage.tsx`.
(`ArticleList.tsx` unchanged — it already renders the `viewTitle` prop.)

Verification: `npm run fmt:check` clean, `npm run lint` clean, `cd client && npm run
typecheck` clean, full server suite 48/48 pass (incl. 6 new search tests).
