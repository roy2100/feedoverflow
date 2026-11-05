# Plan: one type and radius scale, hover in CSS

## Goal

The client has 294 inline style blocks, and each picks its own numbers: 14 font sizes (10, 10.5, 11,
11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 16, 22, plus a clamp) and 11 radii. 19 controls change
color on hover by writing to `element.style` from `onMouseEnter`/`onMouseLeave`. Give the sizes one
scale and move that hover to CSS. Inline styles stay: tokens inside them fix the unity without
rewriting the components.

Complexity: Medium. Mechanical, but it touches most components, and it changes how they look by up
to a pixel.

## Scope

In:
- Tokens in `index.css`: `--text-xs` 11, `--text-sm` 12, `--text-md` 13, `--text-lg` 14,
  `--text-xl` 15, `--text-prose` 16, `--text-display` 22; `--radius-xs` 4, `--radius-sm` 6,
  `--radius-md` 8, `--radius-lg` 12.
- Hover classes in `index.css`, replacing the handlers that only change a style.

Out, in `docs/todo-style.md`: a test that holds the scale, and merging odd spacing values.

Also out:
- The two rows that track hover in React state (`FeedsPanel`, `CollectionsPanel`): that state reveals
  actions and disarms a pending delete, which is logic, not color.
- `TrendChart`'s bars (radius 1 and 2): they are data marks, not chrome.
- The article title's `clamp()`, and the `em` sizes inside `.rss-article`, which scale with the text.
- SVG `fontSize` attributes, where `var()` does not apply.

## Mapping

Font size: 10, 10.5, 11 → xs. 11.5, 12 → sm. 12.5, 13, 13.5 → md. 14 → lg. 14.5, 15 → xl. 16 → prose.
22 → display.

Radius: 3, 4 → xs. 5, 6, 7 → sm. 8 → md. 10, 12 → lg. 50% stays.

## Steps

1. Tokens, then a one-off TypeScript AST codemod over numeric `fontSize` and `borderRadius` values,
   ternary branches included. The same values in the reader's CSS string and `.skeleton-bar`.
2. Hover classes under `@media (hover: hover)`, and a codemod that swaps each handler pair for a
   class. They use `!important`, since a resting color set inline beats any stylesheet rule, as
   `index.css` already does for the iOS input size.
3. `npm test`, `npm run typecheck`, `npm run fmt:check`, `npm run lint`, `npm run build`.
4. A constraint in `CLAUDE.md`.

## Risks

- Text that grew by up to a pixel may wrap or clip somewhere tight, such as the sidebar's count
  badges. No test sees that: the owner checks by hand.
- jsdom tests that fire `mouseEnter` only cover the state-based rows, which do not change.

## Outcome

Done as planned, in two commits: 185 values moved to tokens, 19 hover handlers to 8 classes. Tests,
typecheck, format, lint and build pass. The look is for the owner to verify by hand (desktop +
iPhone), above all the wrapping risk. The follow-ups in `docs/todo-style.md` are now complete:
an AST/CSS regression test, weight tokens, a color baseline and the spacing cleanup.
