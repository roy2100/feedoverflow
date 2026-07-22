# Plan: fix iOS edge-swipe-back panel overlap

## Goal
On a standalone iOS PWA, a fast left-edge swipe-back leaves two mobile panels
(订阅源 + 列表) frozen overlapping. Android is unaffected. Make back navigation
render cleanly on iOS without regressing Android.

## Root cause
The three mobile panels are stacked `position:absolute` layers whose visibility is
driven by a `transform: translateX(...)` with `transition: transform 0.28s`
(`App.tsx`). Going shallower is routed through `window.history.back()` →
`popstate` (`useMobilePanelHistory.ts`).

On iOS, the interactive edge-swipe *itself* is a native, gesture-driven visual
handling of the same-document history navigation. When it commits, `popstate`
fires and React re-renders — at which point our CSS `translateX` transition runs a
second 0.28s animation over the top of what the gesture already moved. A fast swipe
interrupts this and freezes the two panels mid-slide → the overlap. Android has no
native back-gesture, so the CSS slide is the only motion and is correct.

## Fix (scope: in)
- `useMobilePanelHistory` also tracks whether the current panel change should be
  animated. Backward changes applied from `popstate` on iOS are marked
  `instant` (no CSS transition); forward pushes (tapping deeper — no native
  gesture competing) keep the slide.
- iOS is detected once (UA + iPadOS-as-Mac touch check) so Android/desktop behavior
  is byte-for-byte unchanged.
- `App.tsx` reads the `instant` flag and sets `transition: 'none'` on both the
  transform and the dim overlay for that render.

## Scope (out)
- No change to forward navigation, the history stack shape, or `openDeepLinked`'s
  synthesized stack.
- No change to Android or desktop rendering paths.
- Not rewriting the stacked-absolute-panel layout into real routed documents.

## Risks / open questions
- The in-app back arrow on iOS also goes through `popstate`, so it too becomes an
  instant (non-animated) back on iOS. Acceptable: in a standalone PWA the edge-swipe
  is the primary back affordance, and an instant back reads as native. It cannot be
  distinguished from the gesture without touch-tracking heuristics, which aren't
  worth the complexity.
- UA sniffing is inherently fragile, but it only ever *removes* an animation on
  iOS; a false positive/negative degrades gracefully to instant/animated back.

## Complexity
Low.
