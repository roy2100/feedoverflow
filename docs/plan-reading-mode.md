# Plan: Desktop Reading Mode (Distraction-Free Fullscreen)

## Goal
Add a "reading mode" to the desktop three-panel layout that hides both the left
`FeedSidebar` and middle `ArticleList`, letting the article body in `ArticleReader`
fill the full window width for distraction-free reading. The feature is **PC-only** —
the mobile layout already shows one panel at a time, so it gains nothing and is
explicitly out of scope.

## Scope

**Included**
- A toggle to enter/exit reading mode on the desktop layout.
- Hiding `FeedSidebar` + `ArticleList` and expanding `ArticleReader` to full width when active.
- Exit affordances: a toggle button + `Esc` key.
- Keep the existing reading content layout (centered, max-width column) so line length
  stays comfortable even at full width.

**Out of scope**
- Mobile (`isMobile`) layout — unchanged.
- Persisting the mode across reloads (it resets to off on load).
- Any change to article fetching, full-content extraction, podcast player, or auth.

## Steps

1. **Add `readingMode` state in `client/src/App.jsx`** (desktop branch only).
   - `const [readingMode, setReadingMode] = useState(false);`
   - Reset to `false` whenever there is no selected article, so an empty reader pane
     can't get stuck fullscreen (e.g. in a `useEffect` keyed on `selectedArticle?.id`,
     or guard the render).

2. **Conditionally render the two side panels in the desktop `return`.**
   - Wrap `<FeedSidebar .../>` and `<ArticleList .../>` so they only render when
     `!readingMode`. The existing `flex: 1` reader container already expands to fill
     remaining space, so hiding the panels makes the reader span the full width with no
     extra layout work.

3. **Pass reading-mode props into `ArticleReader`.**
   - Add `readingMode` and `onToggleReadingMode={() => setReadingMode(v => !v)}` props.

4. **Add the toggle button in `ArticleReader.jsx` desktop action bar.**
   - Place it in the existing `!isMobile` actions `<div>` (near the "加载全文" / "原文"
     buttons), using a `lucide-react` icon (e.g. `Maximize2` to enter / `Minimize2` to
     exit, or `Expand`/`Shrink`). Tooltip: `专注阅读` / `退出专注阅读`.
   - Only show it on desktop (guard already exists via `!isMobile`).

5. **Content width in reading mode.**
   - The inner column currently uses `maxWidth: 680`. In reading mode bump it (e.g.
     `maxWidth: 760` or `820`) so the wider window is used without hurting readability.
     Drive this off the new `readingMode` prop.

6. **`Esc` to exit + keyboard ergonomics.**
   - Extend the existing `keydown` handler in `App.jsx` (the one handling Arrow keys):
     on `Escape`, if `readingMode` is on, exit it. Keep the input/modal guards already
     present. Arrow-key article navigation should continue to work inside reading mode.

7. **Verify with `npm run dev`.**
   - Enter/exit via button and `Esc`; confirm sidebars hide/restore, arrow-key nav still
     works, mobile layout is untouched, and switching articles keeps the mode.

## Risks & Open Questions
- **Toggle icon/label choice** — defaulting to a `Maximize2`/`Minimize2` button with a
  Chinese tooltip; flag if a different affordance (e.g. a top-bar button) is preferred.
- **Esc collision** — `Esc` is not currently bound elsewhere on desktop, so reusing it is
  safe; modals manage their own close behavior and the handler already early-returns when
  a modal is open.
- **No transition** — panels hide instantly (simplest, matches the app's mostly
  instant desktop interactions). A slide/fade could be added later if wanted.

## Estimated Complexity
**Low** — one new boolean of state, a conditional render, one button, and one extra
`Esc` branch in an existing keydown handler. No backend, store, or data-flow changes.

## Outcome
Implemented as planned, Low complexity, no deviations from the design.

**`client/src/App.jsx`**
- Added `readingMode` boolean state (desktop branch only).
- Extended the existing `keydown` handler with an `Escape` branch that exits reading
  mode (input/modal guards preserved; arrow-key article nav still works inside the mode).
  Added `readingMode` to the handler's dependency array.
- Added a `useEffect` keyed on `selectedArticle` that resets `readingMode` to `false`
  when no article is selected, so the reader can't get stuck fullscreen-empty.
- `FeedSidebar` and `ArticleList` now render only when `!readingMode`; the existing
  `flex: 1` reader container expands to full width automatically — no extra layout work.
- Passes `readingMode` + `onToggleReadingMode={() => setReadingMode(v => !v)}` to
  `ArticleReader`.

**`client/src/components/ArticleReader.jsx`**
- Imported `Maximize2` / `Minimize2` from `lucide-react`; accept `readingMode` and
  `onToggleReadingMode` props.
- Added a toggle button in the desktop action row (tooltip `专注阅读` /
  `退出专注阅读 (Esc)`), accent-colored when active. Guarded by `onToggleReadingMode` so
  it never appears in the mobile layout.
- Inner content column widens from `maxWidth: 680` → `820` when `readingMode` is active.

**Verification**
- `npx vite build` passes clean. Mobile layout untouched (button lives inside the
  existing `!isMobile` block; the prop is only passed from the desktop branch).

**Deviations**
- None. Used `Maximize2`/`Minimize2` icons as proposed; content column max-width set to
  `820` (upper end of the suggested `760–820` range).
