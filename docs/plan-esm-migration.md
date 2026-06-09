# Plan: Migrate server/index.ts to ES module imports

## Goal
Convert `server/index.ts` from CommonJS (`require` / `module.exports`) to native
ES module syntax (`import` / `export`), so the backend runs as an ESM file under
Node's native TypeScript type-stripping.

## Scope
- Included: `server/index.ts` imports/exports, `server/package.json` (`type: module`,
  test glob), `server/tsconfig.json` (module/resolution), the 5 test files, and the
  project `CLAUDE.md` notes that describe the CommonJS choice.
- Out of scope: behavior changes, new dependencies, frontend, deploy/launchd plist
  (`node index.ts` works unchanged for ESM).

## Steps
1. `server/index.ts`: replace `const x = require(...) as typeof import(...)` casts with
   `import` statements; derive `__dirname` from `import.meta.url`; replace
   `require.main === module` with an `import.meta` / `process.argv[1]` comparison;
   replace `module.exports = {...}` with a named `export`.
2. `server/package.json`: add `"type": "module"`; change test glob to `*.test.cjs`.
3. `server/tsconfig.json`: set `module`/`moduleResolution` to `nodenext`.
4. Rename the 5 `*.test.js` → `*.test.cjs`. They keep using `require('./index.ts')`,
   which Node 24 resolves via `require(esm)` (index has no top-level await). This
   preserves the `process.env.TEST_DB`-before-require ordering in two tests.
5. Update project `CLAUDE.md` lines that state the server "stays CommonJS".
6. Run `npm run typecheck` and `npm test` in `server/`.

## Risks & Open Questions
- `require(esm)` of `index.ts` from `.cjs` tests must work on Node 24 — verified by
  running the suite (step 6). Falls back to converting tests to dynamic `import()`.
- Default-import interop for CJS deps (better-sqlite3, rss-parser, compression, cors)
  relies on `esModuleInterop` — kept on.

## Estimated Complexity
Medium — mechanical but spans config + tests, with a module-interop risk to verify.

## Outcome
All steps completed as planned. `require(esm)` interop on Node 24 worked without
issue — the `.cjs` test files can `require('./index.ts')` after it was converted to
ESM, and `process.env.TEST_DB` assignment before the require call is preserved.
`tsc --noEmit` and the 20 offline tests pass cleanly. Server boots and serves
requests confirmed via curl against the live instance on port 3002.
