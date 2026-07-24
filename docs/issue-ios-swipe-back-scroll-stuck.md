# Issue: iOS PWA — scroll dead for one touch after a swipe-back

Status: **Fixed** (2026-07-25, commit `e0081a9`).

## Symptom

Platform: **iOS standalone PWA**. Not reproducible on Android.

Repro:
1. On the mobile layout, tap a feed → the 列表 panel slides in.
2. Use iOS's native left-edge **swipe-back** to return to the 订阅源 panel.
3. Immediately try to scroll the 订阅源 list up/down.
4. The first scroll gesture does **nothing** — the list is frozen. Swipe once
   more and it scrolls normally from then on ("再划一下就能滑动了").

Same shape when swiping back from 文章 → 列表: the article list is dead for the
first touch, then works.

## Root cause

Two things combine — neither alone is the bug:

1. **We pin a permanent compositing layer.** Each of the three mobile panels
   (`App.tsx`, mobile branch) is rendered with `willChange: 'transform'`
   *unconditionally*. `will-change` is meant to be a transient hint; kept on
   forever it forces every panel — and the `overflow-y: auto` scroll container
   inside it — onto its own GPU layer for the app's whole lifetime, instead of
   the plain main-thread scroll a non-promoted element gets.

2. **iOS's native swipe-back is browser-driven and leaves the layer stale.** The
   left-edge swipe is a native, interactive gesture WebKit runs itself (not a DOM
   touch sequence we can see). When it commits, `popstate` fires and we snap the
   landing panel back to its resting `translateX(0)` with **no CSS slide** (the
   `instant` path — see `plan-ios-swipe-back.md`). WebKit does **not** refresh
   that composited layer's hit-test / scroll region when the gesture ends; it
   only recomputes on the next `touchstart`. So the panel you land on ignores the
   first scroll touch — that throwaway touch is exactly what forces the recompute.

The tell that it is the compositing layer and not our JS: a panel with **no**
`will-change` is a normal main-thread scroller (which is why `ArticleList`
deliberately avoids `-webkit-overflow-scrolling: touch`, per its own comment) and
never goes stale. Android has no browser-driven back-gesture — its back is a plain
CSS `transform` transition (`instant === false`) whose end does not leave the
layer dirty — so it never shows the bug.

## Fix

Make the layer promotion transient by keying it off the same `instant` signal the
swipe-back already sets:

```tsx
// App.tsx, mobile panel wrapper
willChange: instantPanel ? 'auto' : 'transform',
```

- **iOS swipe-back** (`instantPanel === true`): `will-change: auto` → the settled
  panels de-promote back to plain main-thread scroll and repaint immediately. That
  repaint does the hit-test recompute the user was otherwise triggering by hand,
  so scroll works on the first touch.
- **Forward taps** and **Android back** (`instantPanel === false`): unchanged —
  `will-change: transform` during the slide keeps the animation smooth.

One-line, scoped strictly to the swipe-back path; no timing state, no
`transitionend` bookkeeping, no risk to the forward-slide animation.

## Alternatives considered and rejected

- **Fully-transient `will-change` on all platforms** (track "am I animating" via a
  timer / `transitionend`, drop the hint at rest everywhere). Strictly the
  "cleanest" per MDN, but it adds timing state whose only failure mode is dropping
  the layer mid-animation → jank, to fix a symptom that only exists on the iOS
  `instant` path. Not worth the risk; the permanent layer on Android has no
  observed symptom, only a minor memory cost.
- **An animation library (Framer Motion / react-spring).** Does not touch the root
  cause and likely reproduces it: those libraries animate `transform` and set
  `will-change` under the hood too, often more aggressively. And the iOS
  edge-swipe is a system-level gesture no JS library can intercept or whose layer
  refresh it can control — a JS-driven replacement swipe would mean fighting the
  native gesture, which is worse UX. Net negative.
- **Forced `scrollTop` nudge / reflow after `popstate`.** A viable fallback if the
  `will-change` change turns out not to be enough (i.e. if the stall is WebKit's
  gesture recognizer holding the touch rather than a stale layer). Not needed
  unless the fix above proves insufficient on a real device.

## How this class of bug is actually debugged

It is debuggable, but harder than a normal logic bug because the root cause
straddles the JS ↔ browser boundary and needs a real device + a real gesture
(`console.log` can't observe "the layer's hit-test region is stale"):

1. **Minimal repro** — strip to one `translateX` panel + one `overflow:auto` and
   confirm it still reproduces, ruling out list/store/animation specifics.
2. **Single-variable A/B on a real iPhone** — toggle one property at a time:
   remove `will-change` (fixes it) vs. remove `transform` (still broken) vs.
   `translate3d`/`translateZ(0)` (reproduces) vs. Android (never reproduces). Those
   pairings pin the trigger to "forced compositing layer + iOS native back",
   independent of any specific property or library. This is ordinary bisection.
3. **Safari Web Inspector over USB** — inspect the Layers panel (what is
   promoted), watch repaints, and confirm whether touch events reach the handler
   but scroll doesn't move (stale layer) vs. touch never dispatches.

The ceiling: you can reliably localize the *trigger* this way, but "why WebKit
doesn't refresh the layer after its own gesture" is a browser-internal you match
against known behavior (WebKit bug tracker / community reports), not something you
step into from your own code.

## Related

- `plan-ios-swipe-back.md` — introduced the `instant` flag this fix reuses (it
  killed the competing CSS slide on iOS back; this fixes the scroll deadness the
  same composited-panel setup also caused).
- `issue-ios-pwa-list-scroll.md` — a separate, still-open iOS list mis-paint bug on
  the same panels. Its "Ideas not yet tried" list already named "gate / remove the
  permanent `willChange`"; this fix does exactly that for the swipe-back case, so
  it is worth retesting that issue on iOS to see whether it also moved.
