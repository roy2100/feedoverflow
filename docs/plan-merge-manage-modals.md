# Plan: one 管理 modal, two tabs — and one fewer sidebar control

## Goal

Collapse the three source-management modals (`AddFeedModal`, `ManageFeedsModal`,
`ManageCollectionsModal`) into a single tabbed shell, and delete the free-floating `+` that the
合集 section header carried.

## Why

Three separate problems, one shape:

1. **The 合集 `+` had nothing to anchor to.** Pinned right by `justify-content: space-between`, it
   floated a full row-width away from the label it belonged to and landed under the scrollbar. It
   also lied: a `+` that opens a modal titled 管理合集.
2. **Two gears meant two different things.** `Settings` in the sidebar header opened 管理订阅源;
   `SlidersHorizontal` in the footer opened 设置. The gear is the universal symbol for global
   configuration — letting the footer own it exclusively is the disambiguation.
3. **Feeds and collections were managed through mirrored-but-unequal doors.** Feeds: a top-bar `+`
   to add and a top-bar gear to manage, with no add affordance inside the manager.
   Collections: one door in the nav, opening a manager that *does* contain its own 新建.

The rejected alternative was folding 新建合集 into the top-bar `+`. `AddFeedModal` already has a tab
strip — `手动添加 | 导入 OPML` — whose axis is *two ways to add one thing*. Adding a 合集 tab beside
them puts two axes (method, object) in one strip. Nesting a second strip to fix that buys a
two-level navigation for the rarest action in the app.

## Scope

**In**

- New `ManageModal` shell: tab bar (订阅源 | 合集), close button, per-tab count, and a one-level
  sub-view that replaces the tab bar with a title + back arrow.
- The three modals become bodies: `AddFeedPanel`, `FeedsPanel`, `CollectionsPanel` — no
  `ModalOverlay`, no header, no `onClose` of their own.
- Adding a feed becomes a sub-view of the 订阅源 tab. The toolbar `+` opens the modal straight into
  it, so the frequent action keeps its one-click path.
- The 合集 section header loses its `action` and renders only when there are collections, matching
  订阅源.
- Sidebar toolbar icon `Settings` → `SquarePen`, tooltip 管理.

**Out**

- 设置 stays in the footer, unmerged. It is configuration (RSSHub address, translation endpoint and
  key), not content; it is opened once a month; and the tab bar of a manager whose two entries are
  lists has no room for a third that isn't one.
- No server change. No store change.
- The mobile panel model, push semantics, and collection rule semantics are untouched.

## Steps

1. `git mv` the three component files to their panel names; strip each of `ModalOverlay`, its
   header, and its own dismissal wiring.
2. `CollectionsPanel` exports `CollectionList` + `CollectionEditor` separately — the shell owns
   navigation, so the panel no longer holds the `editing` state.
3. `FeedsPanel` gains an `onAddFeed` footer button (新建订阅源), mirroring the collections tab.
4. Write `ManageModal`: `tab` + `sub` state, `initialTab` / `initialSub` props, Escape unwinding.
5. `App.tsx`: four modal booleans → `manage: { tab, sub? } | null` + `showSettingsModal`.
6. `FeedSidebar.tsx`: drop `onOpenCollectionsModal`, drop `SectionLabel.action` and
   `IconBtn.inline`, swap the toolbar icon. Keep the hover-background added to `IconBtn`.
7. `pages/FeedsPage.tsx`: drop the same prop.
8. Tests: `AddFeedModal.test.tsx` → `AddFeedPanel.test.tsx`, `ManageFeedsModal.test.tsx` →
   `FeedsPanel.test.tsx` (both render the panel directly), plus a new `ManageModal.test.tsx` for
   the shell's navigation.
9. Update `CLAUDE.md`.

## Risks / open questions

- **Escape from the add sub-view.** Entering the modal at a sub-view makes "back" ambiguous: the
  list behind it is not where the user came from. Resolved with `subIsEntry` — backing out of the
  sub-view the modal *opened into* closes the modal outright; backing out of one navigated to from
  the list returns to the list. Without it, dismissing a mis-clicked `+` would take two Escapes.
- **Discoverability of collections with none created.** The nav section now hides when empty, so
  the only entry is 管理 → 合集. That is the trade the merge buys; the previous rule (keep the
  header even when empty, because it is the only entry point) no longer applies and its comment in
  `CLAUDE.md` must go with it.
- The collections tab's editor is the only sub-view with unsaved state. Switching tabs while it is
  open would silently discard edits — the tab bar is hidden inside a sub-view, so this is
  unreachable by construction. Keep it that way.

## Complexity

Medium — no new behavior, but it touches every source-management surface plus two test files.

## Outcome

Done as planned, with these notes:

- `FeedsPanel`'s footer button reuses the add sub-view rather than embedding a second copy of the
  form, so the OPML path stays reachable from inside the manager too — the panels' 新建 buttons are
  now genuinely symmetric (both open a sub-view of their own tab).
- `AddFeedPanel` keeps its `手动添加 | 导入 OPML` strip inside the body, below the shell header.
  Only one strip is ever on screen: the shell's tab bar is replaced by the sub-view title, so the
  two never nest visually.
- Test files landed as `AddFeedPanel.test.tsx` (panel, direct) and `FeedsPanel.test.tsx` (panel,
  direct), with the dismissal assertions that used to live in `AddFeedModal.test.tsx` moved into
  the new `ManageModal.test.tsx`, where the shell actually decides them.
- `client/src/lib/push.ts` carried a comment naming `ManageFeedsModal`; updated to `FeedsPanel`.
