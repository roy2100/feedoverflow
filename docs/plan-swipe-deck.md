# Plan: 刷 — a vertical, one-card-per-screen swipe mode (mobile)

Status: **Phase 1 done (2026-10-02); Phase 2 (card images) not started.**

## Goal

On the phone, browse articles TikTok-style: one article fills the screen, a vertical swipe
moves exactly one card, a tap opens the full reader. The content can be a subset of
everything fetched — the deck does not have to show every article.

## Measured starting point (production DB, last 7 days)

| | |
|---|---|
| articles | 7056 (~1000/day) — 华尔街见闻快讯 2285, Reuters/Google News 943, Bloomberg 793 |
| `summary` > 80 chars | 4790 (68%) — stored as **plain text** (`feed.stripHTML`), avg 539 chars |
| any `<img>` | 1455 (21%) — **all in `content`**, never in `summary` |
| `title_zh` set | 2896 (41%) |
| podcasts | 15 |

Consequences that shape the design:

1. **The subset is not optional.** ~1000 cards a day is not swipeable; and three firehoses
   would own a newest-first deck.
2. **It is a text-first deck.** Four in five cards have no image; a card must look finished
   with title + summary alone. An image is a bonus, never a layout requirement.
3. **Cards need the summary, which list responses strip** (`wantSummary`). And no list query
   may read `content` (`articleColsNoContent`), so a card image cannot come from the body at
   request time.

## Key decision: a presentation of the list, not a new view

The deck is a second way to **render the current list** — rows or cards — not a new
`View.type`, endpoint, or source. The subset is whatever the list already is:

- 今日 + 均衡 (`digest`) — per-feed quota, so the firehoses can't drown the rest;
- a **合集** — the existing tool for "a subset of everything", keyword- and feed-scoped;
- one feed, 收藏, 播客, a search.

Why this over a dedicated curated stream ("刷" with its own selection algorithm):

- Collections already are the subset mechanism, with an editor, tests and semantics. A
  second selector would be a parallel concept doing the same job worse.
- Deck and list share `articles`, star state and the reader with zero sync code.
- No new view type means `viewTitle`, `selectView`, `lastListView`, scoped search and
  the trend view need no cases added.

The alternative — an algorithmic subset (only cards with a summary ≥ N chars, per-feed cap,
last 24h) — is listed under Open questions; it can be layered on later as a client-side
filter of the same list without changing anything below.

## UX

```
┌──────────────────────────┐
│ ←  今日          12 / 214 │  overlay top bar (back = 订阅源, same as the list)
│                          │
│ [ hero image, ~40% ]     │  only when imageUrl exists AND 无图模式 is off
│                          │
│ ◎ 联合早报 · 14:05        │  favicon + feed + relative time
│ 标题（titleZh 优先）       │  large; original title muted below when translated
│ Original title           │
│ 摘要 …… (line-clamped,    │  never scrolls inside the card
│ fades out at the bottom)  │
│                     ★  ↗ │  star · 原文 (▶ for podcasts)
└──────────────────────────┘
```

- **Swipe up/down** = next/previous card, one at a time.
- **Tap the card** = open the reader (panel 2); ← returns to the same card.
- **Toggle** rows ⇄ cards: one icon button in the mobile list header, mirrored in the
  deck's top bar. Persisted per device in `localStorage` (like `list-mode`). Hidden on the
  趋势 tab — the chart is that view's point. Mobile only; desktop already has ↑/↓.
- **End card**: 「到底了 · 共 N 篇」 + 刷新.
- No new sidebar control — the CLAUDE.md "three controls, three meanings" rule holds.

## Mechanics

### Gesture: CSS scroll snap, no JS touch tracking

```css
scroller { overflow-y: auto; scroll-snap-type: y mandatory; overscroll-behavior: contain; }
card     { height: 100%; scroll-snap-align: start; scroll-snap-stop: always; }
```

Native momentum and rubber-banding, one card per fling (`scroll-snap-stop: always`, iOS
15+). `plan-drop-mobile-history.md` deliberately declined JS gesture tracking for its
complexity and iOS fragility; scroll snap keeps that position.

The current index comes from an `IntersectionObserver` (threshold ~0.6) and only drives
the `n / N` counter. Swiping must **not** call `selectArticle`: that sets
`selectedArticle`, and the always-mounted `ArticleReader` would fetch
`/api/articles/:id/content` for every card flicked past. `selectArticle` runs on tap only.

All cards are rendered (≤ 500, `content-visibility: auto`, images `loading="lazy"`).
Virtualization is trivial here (every card is one container-height) but is deferred until
measured to be needed.

### Where it mounts

Panel 1 of the existing mobile stack renders `<ArticleDeck>` instead of `<ArticleList>`
when the presentation is `deck`. Nothing about `PANEL_DEPTH` or `MobilePage` changes; the
reader's back already targets panel 1, so it lands on whichever presentation is showing.
Because the panel stays mounted, the card position survives a reader round trip.

### Data

- **Summary snippets.** In deck mode the store appends `?summary=short`; the server
  truncates to a fixed 300 runes. `?summary=1` (MCP) is unchanged. Full summaries would
  ship one 28 kB HackerNews每日摘要 per row; 300 runes is more than a card can show.
  Switching rows → cards reloads the view (summaries were stripped); cards → rows does not.
  Desktop never sends it.
- **Card image (phase 2).** New column `article_states.image_url`, derived at persist time
  in `internal/feed`, first hit wins:
  1. gofeed `item.Image`
  2. `media:thumbnail` / `media:content` (Media RSS extension)
  3. an enclosure whose type is `image/*`
  4. the first `<img src>` in `content`

  It is a content-derived field, so the upsert refreshes it with `content`. Carried on
  every list row unconditionally as `imageUrl` (a URL is the size of `titleZh`; same
  reasoning as that field's comment in `RowToArticle`). Added to both column constants, so
  the scan order stays shared. Backfill: a one-off migration over the last 14 days only
  (~14k rows' `content` read once), not the whole 2 GB table.
- **Hotlinking.** Card `<img>` uses `referrerPolicy="no-referrer"` (several Chinese CDNs
  block foreign referers but allow none). `onError` drops the hero and the card falls back
  to the text layout.
- **无图模式** (`plan-text-only-mode.md`) suppresses card images too.

### What deliberately does not change

- **No read/unread state.** CLAUDE.md is explicit that the reader has no such concept. The
  deck opens on the newest card every time; pull-to-refresh / view switch returns to the
  top. The deck never hides "already seen" cards.
- No server endpoint, no new `View.type`, no poller/push/MCP change, no desktop UI.

## Scope

### Phase 1 — text deck (client + one query param)

1. `server-go`: `wantSummary` becomes three-valued (none / short / full);
   `articles.Snippet(s, 300)`; tests for both.
2. `types.ts`: `ListPresentation = 'rows' | 'deck'`.
3. `store.ts`: `presentation` + `setPresentation` (persist, reload when entering `deck`),
   `?summary=short` when the deck is active on mobile.
4. `components/ArticleDeck.tsx`: scroller, card, top bar, end card, IntersectionObserver.
5. `ListPage.tsx`: render deck vs list; `ArticleList.tsx`: the toggle in the mobile header.
6. Tests (vitest): renders one card per article, tap opens reader without swipe
   selecting, star toggles, titleZh/original display, end card.
7. CLAUDE.md: one paragraph under Architecture + the `?summary=short` note on the API table.

### Phase 2 — card images

8. `internal/feed`: `Item.ImageURL` extraction + table-driven tests (each of the 4 sources,
   relative `src`, data: URIs rejected, http→ left to the browser's upgrade).
9. `internal/db`: migration `ADD COLUMN image_url` + bounded backfill.
10. `internal/store`: persist insert/update, both column constants, `scanArticleRow`,
    `articles.Row`, `model.Article.ImageURL`, client `Article.imageUrl`.
11. Card hero + `no-referrer` + `onError` fallback + 无图模式.

## Risks

- **iOS scroll containers in transformed panels** (`issue-ios-pwa-list-scroll.md`, still
  open). In a snap deck a stale offset shows as half a card. Mitigation built in: when
  panel 1 becomes active again, re-assert `scrollTop = index * clientHeight` — cheap since
  the index is tracked, and it is the "scrollTop nudge" that issue lists as untried.
- **Height changes** (podcast player bar appears, PWA viewport changes) shrink the scroller;
  snapping should re-align on its own but must be checked on device. Same re-assert as above
  on `ResizeObserver`.
- **Snap + `content-visibility`** has had WebKit bugs; drop the latter if cards flash.
- **Hotlink-protected images** that also reject no-referrer just fall back to text.

## Open questions

1. **Subset definition** — this plan makes the deck a presentation of the current list
   (subset = the view / a 合集). Alternative: a dedicated deck with its own selection
   (e.g. last 24h, digest quota, cards with no summary dropped). Recommended: the former,
   with the quality filter as a later client-side option if title-only cards (Hacker News:
   avg summary 8 chars) feel empty.
2. Whether to ship Phase 1 alone first to try the interaction before paying for the
   schema change. Recommended: yes.
3. Later, maybe: a per-view 「上次看到这里」 divider (a pub_ts watermark in localStorage).
   It is a position, not per-article state, but it is the nearest thing to unread this app
   would have — deliberately not in this plan.

## Complexity

**Medium.** Phase 1 is client-heavy, ~1 new component plus small edits and one server
param. Phase 2 adds a schema migration and parser work. Main uncertainty is iOS scroll
behaviour, which can only be verified on device.

## Outcome

Decision taken on open question 1: **the deck is a presentation of the current list**
(subset = the view / a 合集). Mobile only, as planned. Phase 1 shipped; Phase 2 not started.

Done:

- Server: `wantSummary` is now a three-valued `summaryMode` (none / short / whole) with
  `keep()` and `clip()`; `short` cuts to `cardSummaryLen = 400` UTF-16 units (the unit search
  already uses) and appends `…` when it cut. Wired into all-articles, today, feed, collection
  and **podcasts** (which previously ignored `?summary` entirely). Test:
  `TestListArticlesShortSummary` + a `short` case in `TestFeedArticlesSummaryParam`.
- Client: `ListPresentation` type; `presentation` / `setPresentation` in the store
  (`localStorage['list-presentation']`); `?summary=short` only when the deck is on **and**
  the width is mobile (`isMobileWidth()`, now exported from `useIsMobile.ts` so the
  breakpoint stays single-sourced); `ArticleDeck.tsx`; `GalleryVertical` toggle in the
  mobile list header, `Rows3` back in the deck's bar; `ListPage` renders one or the other
  and passes `active` from `App`.
- Tests: 10 in `ArticleDeck.test.tsx` (incl. "scrolling opens nothing"), 9 in
  `store.test.ts`. Full suite 292 pass; typecheck, lint, fmt, `make check` clean.

Deviations from the plan:

- **No favicon on the card.** `Article` carries `feedId`, not the feed URL, so it would need
  a feeds lookup threaded into the deck; the feed name alone carries the information.
- **400, not 300, characters.** Measured against a 390 px phone: ~16 lines of 16 px text
  fit, which is ~340 CJK or ~670 Latin characters — 300 left English cards half empty.
- **No `content-visibility: auto`.** Each card measures whether its summary overflows (to
  fade only text that is actually cut), and skipped layout would measure 0.
- **Index from `scrollTop / clientHeight`, not an IntersectionObserver.** Every card is
  exactly one scroller-height, so the division is exact and needs no observer.
- The summary fade is re-measured on summary change only, not on resize.

### Manual test (iPhone PWA)

1. Open 今日 → tap the card icon (right of 最新|摘要) in the list header. The list reloads
   as full-screen cards; the header shows `1 / N`.
2. Swipe up: exactly one card moves per fling, even a hard one. Counter follows.
3. A long-summary card (e.g. 人人都是产品经理) fades out at the bottom; a short one (快讯)
   sits centred with no fade.
4. A translated headline shows 中文 large with the original beneath.
5. Tap ★ → it fills, the reader does **not** open. Tap 原文 → opens the link only.
6. Tap the card body → reader opens; ← back → the **same card**, aligned to the top edge
   (no half card — this is the iOS scroll-offset risk).
7. 播客 view → card shows the duration; tap it → player bar appears, the card re-aligns
   to the shorter panel.
8. Swipe to the end → 「到底了 · 共 N 篇」; tap 刷新 → back at card 1.
9. Run a search → switch to 趋势 → rows with the chart, no card button. Back to 结果 →
   cards again.
10. Tap the rows icon → list returns; kill and relaunch the app → the chosen mode persists.
11. Desktop browser: no card button anywhere; Network tab shows no `summary=short`.
