# Issue: iOS Safari — article list scroll position wrong on re-entry

Status: **Open / unresolved** (parked 2026-06-12). All attempted fixes reverted; tree is back to the committed state.

## Symptom

Platform: **iOS Safari** — reproduces both as an installed PWA **and in a normal Safari tab** (non-PWA). In non-PWA mode the article list offsets **upward even more** than in PWA mode. Confirmed **NOT reproducible on Android**.

Repro:
1. Open a feed's article list page (mobile).
2. Scroll the list down.
3. Leave and re-enter the list page.
4. The list ends up at a wrong scroll position — the **first article row is partially hidden behind the list header**.

Screenshot in the original report shows the `ArticleList` mobile header (`< 鏈新聞 ABMedia`) with the first row clipped underneath it.

## Affected code

- `client/src/components/ArticleList.jsx` — the list panel. Its header is a **sibling above** the scroll container (`flexShrink: 0` header, then a separate `overflow-y: auto` div).
- `client/src/App.jsx` (mobile branch) — three panels are kept mounted and slid with `transform: translateX(...)`, `willChange: 'transform'`, `position: absolute; inset: 0`, inside a `overflow: hidden; position: relative` parent.
- `client/src/components/ArticleReader.jsx` — for contrast, the reader's header is `position: sticky` **inside** its scroll container, and it was *not* reported as broken.

## Working theory

iOS Safari/PWA appears to mis-clip / mis-paint an `overflow` scroll container's top edge when the container lives inside a composited, absolutely-positioned, `transform`ed panel. After the panel slides off-screen and back, the scrolled content bleeds up into the sibling header's region. Android clips correctly, so it never shows there.

This is consistent with the reader (sticky header *inside* the scroller) not being reported broken, vs. the list (header *outside* the scroller) being broken.

## Attempts that did NOT fix it (all reverted)

1. **Guard `scrollIntoView` to desktop only** in `ArticleList` — the effect that keeps the selected row visible was running on mobile while the panel slid away. Plausible improvement, but did not fix the symptom.
2. **Remove `-webkit-overflow-scrolling: touch`** from both `ArticleList` and `ArticleReader` scroll containers (deprecated; a known trigger for iOS scroll-compositing bugs). No effect on the symptom.
3. **`transform: none` for the on-screen panel** in `App.jsx` (instead of `translateX(0)`), so the visible scroller has no non-identity transform ancestor. No effect.
4. **Move the list header inside the scroll container as `position: sticky`** (to match the reader). The most promising structurally, but the user reported it still reproduced.

## Ideas not yet tried

- Gate / remove the permanent `willChange: 'transform'` on the panels (it forces a persistent GPU layer even at rest — a possible remaining compositing trigger that attempt #3 did not remove).
- After the slide transition ends, force the active scroller to re-composite via a `scrollTop` nudge / forced reflow (read then re-write `scrollTop`) — a common pragmatic workaround for this class of iOS bug. Requires wiring an "active page" signal down to `ArticleList`.
- Avoid keeping inactive panels mounted with a transform at all — e.g. only render the active panel (loses the cross-panel slide animation), or reset/restore scroll explicitly on transition.
- Explicitly reset list `scrollTop` to 0 on feed/view change (deterministic top-alignment on entry), accepting the loss of scroll restoration when returning from the reader.

## Update 2026-06-12: PWA-specific hypothesis ruled out

The bug reproduces in a **plain iOS Safari tab too**, not just the installed PWA — and there the list offsets **upward even more**. So it is **not** a PWA-standalone / `display: standalone` quirk (safe-area, status-bar, app-shell viewport, etc. are off the hook).

Implications for the theory:

- It is a general **iOS Safari (WebKit) rendering bug**, present in both display modes; PWA mode just shows a smaller offset, suggesting the magnitude depends on something that differs between the two (e.g. viewport chrome height, `100dvh` resolved value, or scroll-anchoring behavior), while the underlying mis-paint/mis-clip is the same.
- That the offset **differs by display mode** points more toward a **dynamic-viewport / `100dvh` layout interaction** (the resolved height of `html, body, #root { height: 100dvh }` changes as Safari's toolbars show/hide, and differs PWA vs. tab) than a pure compositing-clip bug. Worth testing with a fixed `height: 100%` + a JS-set `--vh` custom property, or `100svh`, instead of `100dvh`.
- Next concrete experiment: on iOS, log `listRef.scrollTop` and the scroller's `getBoundingClientRect()` in the broken state to see whether `scrollTop` is genuinely wrong or the element is laid out at the wrong `top` (the latter would confirm the viewport-height theory).

## Notes

- Could not test on a real iOS device from this environment; all reasoning was static. A device + Safari Web Inspector session is likely needed to confirm the actual cause (inspect the scroller's `scrollTop` and layer bounds in the broken state).
