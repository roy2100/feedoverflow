# TODO: style

Left over from `docs/plan-style-scale.md`.

## A test that holds the scale

Without one, the scale drifts back. A vitest test that walks `client/src` with the TypeScript
compiler (already a dev dependency), not a regex, which misses `isMobile ? 16 : 14`:

- `fontSize`, `borderRadius`, `fontWeight` and colors must be tokens, not literals.
- Colors have a lot left (19 raw values, 42 uses; `#fff` alone is 11), so it records a baseline of
  what exists and fails only when the count rises or a new value appears. Migrating lowers the
  baseline; it never goes up.

Do this first of the two: it stops new drift, and it changes nothing on screen.

## Merge odd spacing values

26 distinct spacing values, 59% of uses on a 4px grid; `padding` has 59 distinct spellings. Don't
force a 4px grid: 6, 10 and 14 are common and reasonable, and moving them would shift the whole
UI for little gain. Merge only the stragglers, each to whichever neighbour fits:

3 → 2 or 4, 5 → 4 or 6, 7 → 6 or 8, 9 → 8 or 10, 13 → 12 or 14, 18 → 16 or 20, 22 → 20 or 24.

That leaves 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32. Some of the small non-integer values counted
(0.1, 0.4, 0.8, 1.2) were not traced to their source; check them first.
