# TODO: style — completed

Follow-up to `docs/plan-style-scale.md`. Both tasks are complete.

## [x] A test that holds the scale

`client/src/__tests__/styleScale.test.ts` walks production sources through the TypeScript
compiler, including conditional branches, constant references, shared style objects, JSX attributes
and direct style assignments. It also parses CSS files and embedded `textContent` / `cssText`
styles with PostCSS. Test fixtures and comments do not contribute to the production baseline.

- `fontSize`, `borderRadius` and `fontWeight` must reference defined tokens of the corresponding
  scale. The four weight tokens preserve the existing 400 / 500 / 600 / 700 values.
- Exceptions stay narrow: 50% radii, the reader h1's existing `clamp()`, prose `em` font sizes,
  SVG text size attributes, the two chart legend marks and `@font-face` weight descriptors.
- Colors include SVG attributes, gradients, shadows and named colors. The current baseline is
  **17 values / 38 uses**, recorded in `style-colors.baseline.json`; token definitions are excluded.
  The test fails when a value's count increases or a new value appears. Lower/remove baseline
  entries when migrating a color to tokens; never increase them to pass a failure.
- The touch-input font size and scrollbar radius now use the existing scale tokens too.

Run with `cd client && npm test -- src/__tests__/styleScale.test.ts`; it also runs in `npm test`.

## [x] Merge odd spacing values

Merged 40 spacing declarations, choosing neighbours by their role:

- 3 → 2 for segmented-control insets and icon alignment; 3 → 4 for gaps and button padding.
- 5 → 4 for label spacing, compact action gaps and mobile skip buttons; 5 → 6 for input/button
  padding and skeleton row gaps.
- 7 → 8 for row and button padding; 9 → 8 for compact segmented controls and → 10 for menu padding.
- 13 → 14 for the manage header; 18 → 20 for form/settings insets.
- 22 → 24 for feed-detail indents, keeping the URL and error messages aligned with one another.

The small decimals were traced: 0.1em letter spacing and the reader's 0.1 / 0.4 / 0.8 / 1.2em
spacing are relative typography; opacity is not spacing. Those remain unchanged. The common
6 / 10 / 14px values remain too. Larger layout insets and deliberate optical offsets were not
forced onto a new grid.

Validation: all 281 client tests pass; typecheck, production build, format check and lint pass.
Desktop and iPhone appearance, especially wrapping and control spacing, still needs a manual visual
check.
