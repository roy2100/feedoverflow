# Plan: Auto-refresh the Today view

## Goal
Keep the `today` view current without user interaction by re-fetching `/api/today` on a
5-minute, foreground-only interval and merging results non-destructively — so the list never
blanks, the open article never disappears, and no scroll/loading flash occurs mid-read.

## Scope
- Included: a `refreshToday` store action (non-destructive merge) + a `setInterval` in `App.tsx`
  scoped to `selectedView.type === 'today'`, paused while the tab is hidden.
- Out of scope: auto-refresh for `all` / `starred` / `search` / single-feed views; forcing an
  upstream RSS pull (server cache TTL still governs freshness); a "N new articles" banner.

## Steps
1. Add `refreshToday: () => Promise<void>` to `StoreState` and implement it in `store.ts`:
   - Bail unless the current view is `today` (guard before and after the fetch for races).
   - Fetch `/api/today`; treat the response as authoritative for ordering.
   - Pin `selectedArticle` even if it aged out of "today" (e.g. across midnight) so it never vanishes.
   - No-op when the resulting id sequence is unchanged — avoids a pointless re-render every tick.
   - Never touch `loadingArticles` or blank `articles` (the key difference from `loadArticles`).
2. Wire a `useEffect` in `App.tsx`, dep `[selectedView.type, refreshToday]`:
   - `setInterval` at 5 min; each tick skips when `document.hidden`.
   - `visibilitychange` listener refreshes immediately when the tab returns to foreground.
   - Tear down interval + listener on cleanup.

## Risks & Open Questions
- Prepending new rows shifts content under a scrolled-down reader. Accepted for now (small deltas,
  5-min cadence); a scroll-anchor or banner can come later if it proves annoying.
- Freshness ceiling is the server's 5-min `feed_cache` TTL — an in-window tick returns identical
  items and the no-op guard makes it a free call.

## Estimated Complexity
Low — one store action + one effect, no server or schema changes.

## Outcome
Implemented as planned, no deviations:
- `store.ts`: added `refreshToday` to `StoreState` and the implementation — view-guarded before/after
  fetch, pins `selectedArticle` when it ages out of "today", and no-ops when the id sequence is
  unchanged. Never touches `loadingArticles`/`articles` blanking.
- `App.tsx`: 5-min `setInterval` effect scoped to `selectedView.type === 'today'`, skips ticks while
  `document.hidden`, and refreshes on `visibilitychange` when the tab returns to foreground.
- `npm run fmt` / `lint` clean; `client` `tsc --noEmit` passes.
