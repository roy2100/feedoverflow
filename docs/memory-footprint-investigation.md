# Investigation: RSS PWA memory footprint (~300 MB)

## Question
The standalone macOS PWA (`rss.lan`, a WebKit content process) showed ~357 MB in
Activity Monitor. Why, and is it a leak?

## TL;DR
- **Not a leak.** Memory balloons during active reading and is reclaimed (peaked
  527 MB, settled ~291 MB). macOS also compresses the inactive portion.
- **Not JavaScript, not images, not compositing layers.** JS heap ~34 MB, layers
  15 MB, and the user reads almost exclusively in 无图模式 (text-only), so article
  images are never inserted into the DOM or decoded.
- **The dominant driver was the CJK serif webfont** — `Noto Serif SC` at 3 weights
  (400/500/600) loaded from Google Fonts. Held font tables + rasterized CJK glyph
  atlases lived in GPU-backed "graphics" memory.
- Swapping to a **system CJK serif (`Songti SC`)** roughly **halved peak memory
  (527 → 238 MB)** and cut the graphics bucket ~2.5×, but did not eliminate growth:
  any CJK serif still rasterizes glyphs, and there is a ~120 MB font-independent
  floor (DOM + render trees + WebKit resource caches).

## How it was measured
Three independent instruments, all agreeing:
1. **`footprint <pid>`** / `vmmap` on the live WebKit content process — the only tool
   that exposes GPU/compositor-owned ("graphics") memory, which Web Inspector omits.
2. **Safari Web Inspector → Timelines → Memory** — splits `JavaScript` vs `Page`
   (it does NOT break out Images/Layers separately). Total tracked ~334 MB, matching
   `footprint` within ~7%.
3. **Web Inspector → Layers tab** — per-layer backing-store memory (15 MB total),
   which exonerated compositing.

## Key mechanism
`ArticleReader.tsx` injects article HTML via `dangerouslySetInnerHTML`. In 无图模式,
`stripMedia()` removes `<img>` from the HTML string (via an inert `DOMParser`
document) before insertion, so images are never fetched or decoded. The only `<img>`
in the whole client is the sidebar favicon (~16 px, negligible).

That leaves **text rendering** as the growth source. WebKit rasterizes each distinct
CJK glyph, per size, per weight, into GPU glyph atlases. `Noto Serif SC` was loaded at
three weights, so three atlas sets. Also relevant: **CSS `max-width: 100%` does not
reduce decoded image memory** (WebKit decodes at intrinsic size) — noted because it
was an early false lead, not the actual cause here.

## A/B experiment (the decisive test)
Change (uncommitted, then reverted): dropped `Noto Serif SC` from the Google Fonts
load in `client/index.html` and set `--font-serif` to `'NotoPunct', 'Songti SC',
'STSong', serif` in `client/src/index.css`. Deployed via `scripts/deploy.sh`,
relaunched the PWA, measured with `footprint`.

| Session | Total | Graphics (glyphs/tiles) | WebKit-malloc (DOM/render/caches) | Peak |
|---|---|---|---|---|
| Noto Serif SC, full session | 291 MB | **164 MB** | 120 MB | 527 MB |
| Songti SC, few articles     | 124 MB | 12 MB  | —      | 135 MB |
| Songti SC, after a while    | 207 MB | 65 MB  | 118 MB | 238 MB |

Reading: the **graphics bucket** (glyph atlases + compositing tiles) is the
font-dependent part — Noto ~2.5× heavier. **WebKit-malloc (~118–120 MB) is
unchanged** by the font swap; that is the inherent floor.

## Conclusion
The webfont was the largest single, actionable contributor to peak memory. Realistic
steady state: **~200–250 MB with a system serif** vs **~290 MB / 527 MB peak with
Noto Serif SC (3 weights)**. A genuine ~40% cut on total and ~55% on peak — but ~120 MB
is simply what this WebKit PWA costs to render the content and is not reducible by
font choice.

## Decision
**Reverted** to `Noto Serif SC` — the ~40% saving was not judged worth changing the
typeface. Memory is not leaking; it reclaims. Documented here so the tradeoff is known.

## Options if this is revisited
1. **Keep a system CJK serif (`Songti SC`)** — best footprint, no webfont, different look.
2. **Leaner Noto** — load `Noto Serif SC` at **1 weight (400)** instead of 3, or
   self-host a `unicode-range`-scoped subset covering common characters. Recovers most
   of the original look while cutting the glyph-atlas memory (fewer weights = fewer
   atlas sets).
3. **Accept it** — it is normal, non-leaking WebKit text-rendering cost.

## Notes for future measurement
- Use `footprint`/`vmmap`, not Web Inspector, to see glyph/graphics memory.
- Match the workload (same number of articles) for a clean A/B; peak matters as much
  as steady-state.
- The `google-fonts` service-worker cache (CacheFirst, 1-year) means font `.woff2`
  files won't reappear as network requests after first load — download size is not the
  memory cost anyway; in-memory glyph rasterization is.
