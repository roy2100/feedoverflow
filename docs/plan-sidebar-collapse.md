# Plan: Sidebar Collapse (订阅侧边栏折叠)

## Goal
Let the user collapse/expand the entire left subscription sidebar (the red-boxed
`FeedSidebar` panel) on desktop with a single click, freeing horizontal space for the
article list and reader. The collapsed/expanded preference persists across reloads.

## Scope
**Included**
- Desktop three-panel layout only (`App.tsx` non-mobile branch).
- A single toggle button using a `lucide-react` `PanelLeft` icon that **relocates with
  state** (NetNewsWire / macOS Mail pattern):
  - **Expanded (default):** the button lives in the **`FeedSidebar` header** (订阅 title
    row), in the existing header action group — matching reference image #3.
  - **Collapsed:** the sidebar is gone, so the same button appears at the **top-left of
    the article-list header** (`ArticleList.tsx`, left of the `viewTitle` `<h2>`) —
    matching reference image #2.
  - There is exactly one button visible at a time; it both collapses and expands.
- Hiding the whole `FeedSidebar` when collapsed.
- Persisting the collapsed state to `localStorage` so it survives reload.
- A smooth open/close transition consistent with the existing `slideIn` animation.

**Out of scope**
- Mobile layout — it already uses single-pane page navigation (`FeedsPage`/`ListPage`/
  `ReaderPage`), where a collapse toggle is meaningless. No changes there.
- Per-section folding (collapsing only the "订阅源" group) or feed categories/folders —
  explicitly not this task.
- Keyboard shortcut (could be a follow-up; not required).
- Any server / DB / API change. This is purely client UI state.

## Steps
1. **Add collapse state in `App.tsx`** — introduce `sidebarCollapsed` state, initialized
   from `localStorage` (key e.g. `sidebar-collapsed`), with a `useEffect` that writes back
   on change. Default `false` (expanded). Lives next to `readingMode` since both gate the
   desktop sidebar render.
2. **Gate the sidebar render** — in the desktop branch, the sidebar already renders only
   when `!readingMode`; additionally hide it when `sidebarCollapsed`.
3. **Reusable toggle button** — factor a small shared `PanelLeft` toggle (or just reuse
   the sidebar's existing `IconBtn` styling in both spots) so the look is identical in
   both headers: `--text-tertiary`, hover → `--accent`, desktop only.
4. **Button in `FeedSidebar` header (expanded state)** — add it to the header action
   group (`FeedSidebar.tsx:81-93`), as the first/leftmost control to match image #3.
   Extend `FeedSidebarProps` with `onToggleSidebar?: () => void`; render desktop only.
5. **Button in `ArticleList` header (collapsed state)** — when `sidebarCollapsed`, render
   the same toggle at the top-left of `ArticleList`'s header (`ArticleList.tsx:66-109`),
   left of the `viewTitle` `<h2>`, desktop only. Extend `ArticleListProps` with optional
   `sidebarCollapsed?: boolean` and `onToggleSidebar?: () => void`.
6. **Wire through `App.tsx`** — define `onToggleSidebar = () => setSidebarCollapsed(v =>
   !v)`; pass it to `FeedSidebar`, and pass `sidebarCollapsed` + `onToggleSidebar` to
   `ArticleList`.
7. **Transition** — reuse/extend the existing `slideIn` animation so expand feels smooth;
   collapse can simply unmount (or animate width/opacity). Keep it lightweight — no layout
   thrash on the article list.
8. **Interaction with reading mode** — reading mode already hides the sidebar *and* the
   article list, so neither toggle button shows while `readingMode` is on. Exiting reading
   mode restores whatever collapsed/expanded state was set. No extra gating needed beyond
   confirming this.
9. **Lint & format** — run `npm run fmt` and `npm run lint:fix`, then verify
   `npm run fmt:check` and `npm run lint` pass clean. Run `npm run typecheck` in `client/`.
10. **Manual verification** — `npm run dev`, confirm: button in sidebar header collapses
    it; button reappears in article-list header and re-expands; preference survives reload;
    reading mode still hides everything; mobile layout unaffected.

## Risks & Open Questions
- **Persistence key collision** — pick a clearly namespaced `localStorage` key; the app
  currently stores little/none, so low risk.
- **Header layout shift** — inserting the toggle left of the `<h2>` must not break the
  title's `flex: 1` ellipsis behavior; the button is `flexShrink: 0` and the title keeps
  flexing. Verify on a long `viewTitle`.

## Estimated Complexity
Low — single-component UI state plus a render gate and a persisted boolean. No backend,
no data-model change, no mobile impact.

## Outcome
Implemented as planned.
- `App.tsx`: added `sidebarCollapsed` state initialized from `localStorage`
  (`sidebar-collapsed`, `'1'`/`'0'`), a `useEffect` to persist it, and a `toggleSidebar`
  handler. Desktop sidebar render gated on `!readingMode && !sidebarCollapsed`. Passed
  `onToggleSidebar` to `FeedSidebar`, and `sidebarCollapsed` + `onToggleSidebar` to
  `ArticleList`.
- `FeedSidebar.tsx`: added optional `onToggleSidebar` prop; rendered a `PanelLeft`
  `IconBtn` ("收起侧边栏") as the leftmost item in the header, grouped with the 订阅 label
  (desktop only).
- `ArticleList.tsx`: added optional `sidebarCollapsed` + `onToggleSidebar` props; rendered
  a `PanelLeft` button ("展开侧边栏") left of the `viewTitle` `<h2>` when collapsed
  (desktop only), styled to match the sidebar's `IconBtn`.
- Verified: `fmt:check`, `lint`, and client `typecheck` all pass clean.

Deviation from plan: did not add a separate shared toggle component (planned step 3) —
the two call sites use the existing/duplicated `IconBtn` styling directly, which kept the
change smaller. No animation work beyond the existing `slideIn` was needed.
