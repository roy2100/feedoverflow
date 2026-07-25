# Plan: drop the mobile history stack

## Goal

Remove `useMobilePanelHistory` and let the three mobile panels be driven by plain
React state again. The history stack has produced a continuous stream of iOS
rendering bugs; this deletes the mechanism that causes them rather than patching
the next symptom.

## Why

Every one of these is the same defect:

| commit | symptom |
|--------|---------|
| `01eea19` | fast swipe-back freezes 订阅源 + 列表 overlapping |
| `42d979f` | push deep link buries the stack → back replays panels |
| `3039192` | popping onto 文章 with no article draws an empty pane |
| `e0081a9` | scroll dead for one touch after a swipe-back |

iOS's left-edge swipe is a **native, interactive, browser-driven animation of a
history navigation**. We render that same navigation ourselves from `popstate`.
Two animators, one transition, and no handshake between them: WebKit gives us
`popstate` after the fact — no gesture-start, no progress, no cancel — so being in
sync is not achievable, only approximable. `instant`, `willChange: auto` and the
`visiblePage` clamp are three separate approximations, and there is no reason to
believe the list is finished.

With no history entries pushed, iOS has no back target, the gesture never fires,
and the whole class is gone.

Cost, accepted: the edge-swipe stops being a back button; the in-app `←` arrow is
the only back affordance. Mobile use is the installed iPhone PWA only, so there is
no Android system-back to regress. In a plain Safari tab a swipe-back would leave
the site — that was the behavior before the stack existed, and the PWA is the
supported surface (iOS Web Push requires home-screen install anyway).

Priority stated by the owner: repository simplicity over feature count — a small
codebase is what stays stable long-term.

## Scope — in

1. Delete `client/src/hooks/useMobilePanelHistory.ts` and
   `client/src/__tests__/useMobilePanelHistory.test.ts`.
2. `App.tsx`: `useState<MobilePage>('feeds')` replaces the hook. `navigateMobile`
   becomes the setter, so `FeedsPage` / `ListPage` / `ReaderPage` keep their
   existing `onNavigate(page)` prop unchanged.
3. `App.tsx` mobile branch: drop `instantPanel` (transition is always on), drop
   `willChange` entirely, keep a local depth lookup for the `translateX` math.
4. Deep link (`App.tsx`): drop `openDeepLinked` and the `selectView({type:'feed'})`
   synthesis; the effect fetches by id, `selectArticle`s it, and sets the panel to
   `article`. Dropping the feed resolution also drops the `feeds.length === 0`
   wait, and leaves the user's current list untouched when they close the article.
5. Docs: mark `plan-ios-swipe-back.md` and `issue-ios-swipe-back-scroll-stuck.md`
   superseded (their mechanism no longer exists); update the
   `useMobilePanelHistory` line in `CLAUDE.md`; note in
   `issue-ios-pwa-list-scroll.md` that the permanent `willChange` is now gone, so
   that open bug is worth retesting.

## Scope — out

- No JS-driven replacement swipe gesture. It is now *possible* (there is no native
  gesture left to fight, which was the objection in
  `issue-ios-swipe-back-scroll-stuck.md`), but it is the second-largest complexity
  source here — touch tracking, velocity commit thresholds, conflicts with
  horizontal scrollers inside article HTML. Ship the removal alone; add a gesture
  later only if the arrow-only back actually grates.
- No change to the panel layout, the slide animation itself, desktop, or the
  server.
- No attempt to fix `issue-ios-pwa-list-scroll.md` in this change.

## Keep

The `visiblePage` clamp (`mobilePage === 'article' && !selectedArticle → 'list'`)
stays, with a corrected comment: history restore is no longer the trigger, but the
store still clears `selectedArticle` on every `loadArticles` (pull-to-refresh, view
switch), which can still strand an empty reader panel on top.

## Risks / open questions

- **Leftover history entries.** iOS restores a PWA's history session across
  relaunch, so entries pushed by the current build survive the update for a launch
  or two. A swipe-back then fires a `popstate` nobody listens to: the panel does not
  change, and because every entry shares one URL the document is not reloaded.
  Cosmetically inert, self-clearing. Verify once on device.
- **Muscle memory.** Edge-swipe stops working; the `←` arrow is it. Deliberate.

## Verification

`cd client && npm test && npm run typecheck && npm run lint`, then manual on the
iPhone PWA (steps recorded in the Outcome section).

## Complexity

Low — a net deletion (~264 lines of hook + test removed, `App.tsx` shrinks). No
new abstraction.

## Outcome

Done as planned. Net **−284 lines**.

- Deleted `hooks/useMobilePanelHistory.ts` (114) and its test (150). No `pushState`,
  no `popstate`, no UA sniffing, no `instant` flag anywhere in the client.
- `App.tsx`: `useState<MobilePage>('feeds')` — the setter *is* `onNavigate`, so the
  three pages are untouched. `PANEL_DEPTH` moved into `App.tsx` (the only consumer)
  carrying the do-not-reintroduce rationale.
- `willChange` removed outright; both transitions are now unconditional.
- Deep link: one effect instead of two. `pendingArticleId`, the `feeds.length === 0`
  wait, and the `selectView` feed synthesis are all gone — a notification now opens
  the article over whatever list is loaded and leaves that list alone.

Deviations from the plan:

- Also updated the `fetchArticleById` comment in `store.ts:151`, which documented
  the removed "caller must switch to the article's feed first" contract.
- The `CLAUDE.md` change grew from a line edit to a short paragraph: the file listing
  no longer had a hook to point at, and "don't reintroduce `pushState` here" is the
  thing a future reader most needs told.

Checked: `npm test` (119 pass), `npm run typecheck`, `npm run lint`, `npm run
fmt:check` — all clean.

### Manual verification (iPhone PWA)

1. 订阅源 → tap a feed → 列表 → tap an article → 文章. Each step slides in from the
   right, the panel behind parallax-shifts and dims. The ← arrow walks back out.
2. From each panel, try the left-edge swipe: **nothing should happen** (this is the
   intended loss). If it instead navigates or exits, the PWA is still holding history
   entries from the previous build — relaunch it once and retest.
3. Scroll 列表, open an article, come back: the first scroll touch must work
   immediately (the bug from `issue-ios-swipe-back-scroll-stuck.md`).
4. Retest `issue-ios-pwa-list-scroll.md` — the panels are no longer GPU-promoted at
   rest, which was that issue's leading unverified suspect.
5. Push: with the app **closed**, tap a notification → the named article opens
   directly; ← returns to 列表. With the app **open** on some feed's list, tap a
   notification → the article opens and ← returns to *that same list*, still
   scrolled where it was (previously it was replaced by the article's own feed).
6. Pull-to-refresh while reading an article: the panel falls back to 列表 rather
   than showing an empty pane.
