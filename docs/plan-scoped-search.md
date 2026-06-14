# Plan: Scoped Search Toggle

## Goal

Add a toggle button next to the sidebar search box that switches search between
**global** (current behavior — search every fetched article) and **scoped** (search only
within the currently selected category: `Today`, `全部/All`, `Starred`, or a specific RSS
feed). The user controls the scope explicitly via the button; the scope itself is derived
from whichever list view was active before search began.

**Desktop only.** Mobile is explicitly out of scope: on mobile the search box lives on the
`FeedsPage` pane and slides off-screen on submit, so a toggle next to it can't re-scope live
results. The toggle button is **not rendered when `isMobile`** — mobile search stays global
(unchanged from today).

## Scope

**Included**
- A small toggle button rendered to the right of the search `<input>` in `FeedSidebar.tsx`
  (the spot marked in the request screenshot), **desktop layout only**.
- Capturing the "base view" (last non-search view) as the search scope.
- Passing scope to `/api/search` and filtering results server-side.
- Placeholder / visual feedback so the user can tell which mode is active.

**Out of scope**
- **Mobile.** No toggle on `isMobile` — `FeedsPage` keeps using `FeedSidebar` without the
  scope control; mobile search remains global. The server `scope` param is harmless if mobile
  never sends it.
- Multi-select scopes (e.g. search across two feeds at once).
- New persisted settings / DB columns — scope is ephemeral UI state.
- Changing how non-search lists are built (`/api/today`, `/api/all-articles`, etc.).
- Full-text/ranking improvements — still a `LIKE` query.

## Design

### Scope model

A search scope is one of just **two** kinds: `starred` or `feed:<id>`. These are the only
base views where scoping actually changes results with a simple SQL filter. **`全部/All` and
`Today` are deliberately excluded** — `all` would be a no-op equal to global search, and
`today` would require JS date filtering on the RFC-822 `pub_date` string (extra complexity for
little value). Keeping scope to pure SQL filters keeps the logic simple.

The scope is captured from the **last non-search `selectedView`** at the moment a search runs,
so toggling the button while already in a search re-uses that remembered base view rather than
the `search` view itself (which would otherwise clobber the source category).

- Client `View` (`client/src/types.ts`): extend the `search` variant with an optional
  `scope` describing the base view, e.g.
  `{ type: 'search', query, scope?: { kind: 'starred'|'feed', feedId?, feedName? } }`.
- Store (`client/src/store.ts`): track `lastListView` (the most recent non-search view) and a
  boolean `scopedSearch`. `selectView` updates `lastListView` whenever the new view is not
  `search`. The `search()` action builds the scope from `lastListView` when `scopedSearch` is
  on **and `lastListView` is scopable** (`starred` or `feed`); otherwise the search is global.
  Add a `toggleSearchScope()` action that flips `scopedSearch` and re-runs the active search so
  results update immediately.

### Server (`/api/search`)

Accept optional query params `scope` (`starred|feed`) and `feedId`. Build the SQL `WHERE`
incrementally on top of the existing `title/summary/content LIKE` clause:

- missing / unrecognized → no extra filter (unchanged global behavior).
- `starred` → `AND is_starred = 1`.
- `feed` → `AND feed_id = ?`.

No JS date filtering — `today` is not a scope. `q.length < 2` short-circuit stays. Scope
filtering must use the same parameter binding/escaping discipline already used for the `LIKE`
clause.

### UI (`FeedSidebar.tsx`)

- Render the toggle only when **not** `isMobile` **and** `lastListView` is scopable
  (`starred` or `feed`). When the base view is `全部/All` or `Today`, the button is hidden
  entirely — there's no meaningless toggle to confuse the user.
- Add a toggle `<button>` immediately right of the search input (next to the existing clear
  `X`). Use a `lucide-react` icon that reads as "scope/filter" — e.g. `Filter` (active) vs a
  muted/outline state (global). Active state uses `--accent`; inactive uses
  `--text-tertiary`.
- `title` / `aria-label` describes the action, e.g. "在当前分类中搜索" ↔ "全局搜索".
- When scoped, update the input `placeholder` to name the scope, e.g. `在「Starred」中搜索…`,
  `在「MSTR」中搜索…`. Derive the label from `lastListView`.
- Wire `onClick` → `toggleSearchScope()` (passed down from `App.tsx` like `onSearch`).
- Adjust input right-padding so the two buttons (clear + scope) don't overlap the text.

### Data flow wiring

- The desktop `<FeedSidebar>` in `App.tsx` already passes `onSearch={search}`; add
  `onToggleSearchScope` and the current `scopedSearch` flag + scope label (read from the store)
  as props. `FeedsPage` (mobile) does **not** pass these — props stay optional and the toggle
  renders only when present and `!isMobile`.
- `loadArticles` (`store.ts`) appends `&scope=...&feedId=...` to the `/api/search` URL when the
  `search` view carries a scope.

## Steps

1. **Types** — extend `View['search']` with the optional `scope` shape in
   `client/src/types.ts` (mirror in `server/types.ts` if it declares the search response).
2. **Server** — add `scope` (`starred|feed`) + `feedId` handling to `/api/search`
   (`server/app.ts`), pure SQL filters, no date logic. Add a `*.test.ts` case per scope
   (feed / starred / global).
3. **Store** — add `lastListView`, `scopedSearch`, `toggleSearchScope()`; update `selectView`,
   `search()` (only build a scope when `lastListView` is `starred`/`feed`), and the
   `loadArticles` URL builder (`client/src/store.ts`).
4. **Sidebar UI** — render the toggle button (only for scopable base views), dynamic
   placeholder, padding fix; accept the new props (`client/src/components/FeedSidebar.tsx`).
5. **Wire props** — pass scope state + toggle handler from `App.tsx`.
6. **Verify** — `cd server && npm test`, `cd client && npm run typecheck`, `npm run fmt` +
   `npm run lint:fix`, then manual check: scope to a feed, to Starred, toggle back to global.

## Risks & Open Questions

- **Scope coverage vs. visible list**: a `feed` scope searches that feed's **entire** history
  in `article_states`, which is broader than the ~50 recent items shown when you open the feed.
  Intended (search should reach history), but worth noting so it isn't mistaken for a bug.
- **Stale scope after deletion**: if the scoped feed is deleted while a scoped search is active,
  results go empty. Acceptable; the toggle simply won't render once `lastListView` is no longer
  `feed`.
- **Open question (assumed default, not blocking)**: should the scope persist across app
  reloads? Assuming **no** — ephemeral per session. Revisit only if the user asks.

## Estimated Complexity

**Low** — two pure-SQL filter branches on one existing endpoint, a few store fields, and a
self-contained UI button gated on view type. No schema/migration changes, no new endpoints, no
date logic.

## Outcome

Implemented as planned, desktop-only, two scopes (`starred` / `feed`).

- **Types** (`client/src/types.ts`): added `SearchScope` (`kind: 'starred'|'feed'`, optional
  `feedId`/`feedName`) and an optional `scope` on the `View`.
- **Server** (`server/app.ts`): `/api/search` now accepts `scope=starred|feed` + `feedId`,
  appended as a pure-SQL clause on top of the existing `LIKE`. Unknown/missing scope → global.
  Wrapped the `LIKE` group in parens so the scope `AND` binds correctly.
- **Store** (`client/src/store.ts`): added `lastListView`, `scopedSearch`,
  `toggleSearchScope()`, and a `scopeFromView()` helper; `selectView` records the last
  non-search view, `search()` attaches a scope only when scoped and the base view is scopable,
  and `loadArticles` appends the scope query params.
- **UI** (`FeedSidebar.tsx`): a `Filter` toggle button renders right of the search box, only
  when `!isMobile` and the base view is scopable (`scopeLabel` set). Active state uses
  `--accent` + filled icon; placeholder switches to `在「<scope>」中搜索…`. Buttons grouped in
  one absolute flex container; input right-padding adjusts to button count.
- **Wiring** (`App.tsx`): computes `scopeLabel` from `lastListView` and passes the three new
  props to the desktop sidebar only (`FeedsPage`/mobile untouched).
- **Tests** (`server/search.test.ts`): added a second feed + a starred article and four cases
  (global, `scope=feed`, `scope=starred`, unknown-scope fallback). All 76 server tests pass;
  client `typecheck`, `fmt:check`, and `lint` are clean.

No deviations from the final plan.
