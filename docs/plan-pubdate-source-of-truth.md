# Plan: Backend as the single source of truth for article timestamps

## Goal
Article lists sometimes render in non-strictly-descending order. Root cause: two
independent date parsers disagree. The server sorts with native `new Date(pubDate)`,
which returns `Invalid Date` (→ `NaN`) for feeds emitting `2026-06-17 14:14:08  +0800`
(36氪/RssHub: space instead of `T`, doubled whitespace, colon-less offset). `NaN` in the
comparator produces unstable/incorrect ordering. Meanwhile the client displays time via a
robust custom `parseDate`, so it shows the correct time on a wrongly-positioned row.

Fix: make the backend the single source of truth for the timestamp. Parse pubDate robustly
once on the server, sort by that parse, and emit a normalized ISO-8601 `pubDate` so the
client can use native `new Date()` with no second parser. Delete `client/src/parseDate.ts`.

## Scope
Included:
- One robust server-side `parsePubDate` + `byPubDateDesc` comparator + `normalizePubDates`.
- Use the comparator in every list sort and the `/api/today` filter.
- Use `parsePubDate` in `maintenance.ts` `articleTs` (same NaN failure mode).
- Normalize emitted `pubDate` → ISO on every article-returning endpoint.
- Simplify client `formatDate` / `formatFullDate` to native `new Date()`; delete `parseDate.ts`.

Out of scope:
- Changing how `pub_date` is stored in SQLite (kept raw; normalization happens at response time).
- `makeId` (computed from raw item pubDate at persist time — unaffected).

## Steps
1. `server/articles.ts`: add exported `parsePubDate(raw): Date | null` (mirror of the current
   client logic), `byPubDateDesc(a,b)` comparator (null → 0, no NaN), and
   `normalizePubDates(articles)` (mutates `pubDate` → ISO when parseable, leaves raw otherwise).
2. `server/app.ts`: replace the 5 inline `new Date(...)` sort comparators with `byPubDateDesc`;
   replace the `/api/today` filter's `new Date(...)` with `parsePubDate`; call
   `normalizePubDates(articles)` before `res.json` on feed-articles, all-articles, today,
   starred, podcasts, search.
3. `server/maintenance.ts`: `articleTs` uses `parsePubDate(pub_date)?.getTime() ?? NaN`.
4. `client/src/components/ArticleList.tsx` + `ArticleReader.tsx`: parse with native
   `new Date(dateStr)` (guard `isNaN`); drop the `parseDate` import.
5. Delete `client/src/parseDate.ts`.
6. Run server tests, client tests, typecheck, fmt, lint.

## Risks & Open Questions
- Unparseable dates: comparator treats them as epoch 0 (sink to bottom, deterministic);
  `normalizePubDates` leaves the raw string so the client shows blank (same as today).
- Sort recomputes `parsePubDate` per comparison; fine for ≤200-item lists.

## Estimated Complexity
Medium — mechanical, multi-file, but logic is centralized in one helper.

## Outcome
Implemented as planned. One correction to the root-cause framing: Node's `new Date()` is
actually lenient enough to parse the `2026-06-17 14:14:08  +0800` shape (returns the right
UTC), so the server sort was not silently NaN-ing on it — the browser is the strict parser,
not Node. The real fragility was structural: **two parsers** (Node for the sort, the browser's
`parseDate` for display) that could diverge on any input, plus the same-day display ambiguity
(fixed separately in `ArticleList.formatDate`). The client never re-sorts, so render order
always equals server order; consolidating parsing onto the server and emitting canonical
ISO-8601 removes the dual-parser drift class entirely.

Changes:
- `server/articles.ts`: added `parsePubDate`, `byPubDateDesc`, `normalizePubDates`.
- `server/app.ts`: all list sorts use `byPubDateDesc`; `/api/today` filter uses `parsePubDate`;
  every article-returning endpoint normalizes `pubDate` → ISO before `res.json`.
- `server/maintenance.ts`: `articleTs` uses `parsePubDate`.
- Client: `formatDate`/`formatFullDate` use native `new Date()`; `parseDate.ts` deleted.
- Added `server/pubdate.test.ts` (4 tests). Full suites: server 81, client 84, all green.
