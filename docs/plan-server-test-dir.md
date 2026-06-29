# Plan: Move server tests into `server/test/`

## Goal
After the `routes/` split, several test files no longer sit next to the source they exercise
(`routes.test.ts` / `search.test.ts` / `content.test.ts` test handlers now in `routes/`, not
`app.ts`). Colocation has stopped paying off. Move all `*.test.ts` + `*.itest.ts` into
`server/test/`, fix their relative imports, and update the test/typecheck globs so the suite
runs and typechecks exactly as before. Pure relocation — no test logic changes.

## Scope
**Included**
- `git mv` all 9 `*.test.ts` and 3 `*.itest.ts` from `server/` into `server/test/`.
- Rewrite their `'./x.ts'` imports → `'../x.ts'` (the only relative refs; TEST_DB paths use
  `tmpdir()`/`:memory:`, no path churn).
- Update `server/package.json` globs (`test`, `test:integration`, `test:coverage`).
- Update `server/tsconfig.json` `include` to keep `routes/` and `test/` in the type gate.

**Out of scope**
- No source moves (`db.ts`, `cache.ts`, etc. stay flat — see the `lib/` discussion, declined).
- No test logic / assertion changes. No splitting `routes.test.ts` to mirror routers.

## Steps
1. `mkdir server/test`, `git mv` the 12 files in.
2. In each moved file, `'./` → `'../` (covers both `from './x.ts'` and `await import('./x.ts')`;
   verified no other `'./` string literals exist in these files).
3. `package.json`: `*.test.ts` → `test/*.test.ts`, `*.itest.ts` → `test/*.itest.ts`, and the
   two `--test-coverage-exclude='*.test.ts'` → `'test/*.test.ts'`.
4. `tsconfig.json`: `"include": ["*.ts"]` → `["*.ts", "routes/**/*.ts", "test/**/*.ts"]`
   (routes/ were only being checked transitively via app.ts; tests are entrypoints nothing
   imports, so without this they'd silently drop out of `tsc`).
5. Verify: `npm run typecheck`, `npm test` (82 pass / 15 suites), `npm run fmt:check`,
   `npm run lint` from repo root.
6. Update CLAUDE.md tree (`*.test.ts` line → `test/`).

## Risks & Open Questions
- **Type gate silently shrinking** — the real hazard. `include: ["*.ts"]` matches root only;
  moved tests must be re-added or `tsc` stops checking them while still exiting 0. Step 4
  fixes it; confirm by introducing nothing but trusting the existing 82 tests to still typecheck.
- **Glob misses** — if any script/CI references `*.test.ts` outside package.json. Grep first.
- `.itest.ts` moved too (they reference `./parse-url.ts`); they only run under
  `test:integration` (live network), not the default `test`.

## Estimated Complexity
Low. Mechanical move + glob/import path edits; behavior unchanged, fully test-covered.

## Outcome

Done as planned. All 12 files (`git mv`, history preserved) moved to `server/test/`; their
`'./x.ts'` imports rewritten to `'../x.ts'` (only relative refs — TEST_DB paths use
`tmpdir()`/`:memory:`, untouched). `package.json` globs → `test/*.test.ts` /
`test/*.itest.ts` (incl. coverage exclude). `tsconfig.json` `include` →
`["*.ts", "routes/**/*.ts", "test/**/*.ts"]`.

No source moved; no test logic changed. `scripts/loc.sh` needed no edit (recursive `find`
still matches the new path).

Verification: `npm test` → 82 pass / 0 fail / 15 suites; `tsc --listFilesOnly` confirms all
12 `test/` files are in the type gate (the real risk — `include: ["*.ts"]` would have silently
dropped them); `npm run fmt:check` + `npm run lint` clean.
