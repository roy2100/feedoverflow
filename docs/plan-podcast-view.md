# Plan: Add 播客 (Podcast) smart-subscription view

## Goal
Add a 播客 entry to the sidebar's 智能订阅 (smart subscriptions) section, alongside
今日 / 全部 / 收藏, that centrally lists the most recently updated podcast episodes
across all feeds. A "podcast" is any article carrying a non-empty `audio_url`, which
`article_states` already persists for every fetched item.

## Scope
- Included: new `GET /api/podcasts` endpoint, a `'podcast'` view type, sidebar nav item,
  view-title mapping (desktop + mobile), store URL wiring, a server test.
- Out of scope: any change to playback (PodcastPlayer already handles audio), per-feed
  podcast filtering, new DB columns/migrations (audio_url already exists).

## Steps
1. `server/app.ts` — add `GET /api/podcasts`: query `article_states` where `audio_url`
   is non-empty, ORDER BY pub_date DESC (coarse), re-sort by parsed date in JS, slice to
   100. Mirrors `/api/starred` / `/api/search` row→Article mapping.
2. `client/src/types.ts` — add `'podcast'` to `View['type']`.
3. `client/src/store.ts` — add `podcast: ${API}/podcasts` to the `urlMap`.
4. `client/src/components/FeedSidebar.tsx` — add a 播客 `NavItem` (Podcast icon) after 收藏.
5. `client/src/App.tsx` + `client/src/pages/ListPage.tsx` — add `'podcast' → '播客'` to the
   `viewTitle` chain.
6. `server/routes.test.ts` — test that a starred/persisted audio article surfaces in
   `/api/podcasts` and a non-audio one does not.

## Risks & Open Questions
- `pub_date` is an RFC-822 string — SQL ORDER BY is only a coarse text sort, so the JS
  re-sort by parsed date is required (same as existing list endpoints).
- Feed name is kept visible in this view (only `type: 'feed'` hides it) so each episode
  shows which show it belongs to.

## Estimated Complexity
Low — additive, reuses the existing audio_url column and list-endpoint patterns.

## Outcome
Implemented as planned, no deviations:
- `GET /api/podcasts` added in `server/app.ts` (article_states scan on non-empty audio_url,
  JS re-sort by parsed pub_date, slice 100); documented in the CLAUDE.md API table.
- `'podcast'` added to `View['type']` (`types.ts`) and the store `urlMap` (`store.ts`).
- 播客 nav item (lucide `Podcast` icon, #8E5BD9) added after 收藏 in `FeedSidebar.tsx`.
- `'podcast' → '播客'` view-title mapping added in `App.tsx` and `ListPage.tsx`.
- Test in `routes.test.ts` verifies only audio articles appear, newest-first by parsed date.
- Verified: server `npm test` (typecheck + 77 tests pass), client typecheck clean,
  `npm run fmt:check` clean, `npm run lint` exit 0.
