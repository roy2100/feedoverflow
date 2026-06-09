# Plan: Migrate backend to TypeScript (Node 24 native type-stripping)

## Goal
Convert the Express backend (`server/index.js`) to TypeScript and run it
directly with Node 24's native type-stripping — no build step, no bundler.
Add a `typecheck` script (tsc `--noEmit`) so the type annotations are actually
verified, since Node only strips types and does not check them.

## Scope
Included:
- `server/index.js` → `server/index.ts` with full type annotations, keeping the
  existing single-file CommonJS architecture (CLAUDE.md mandates "all API routes
  + SQLite setup in index.js").
- Update entry points that name `index.js`: root `package.json` `server` script,
  `server/package.json` `main`, launchd plist program argument.
- Update test imports `require('./index.js')` → `require('./index.ts')`. Tests
  stay `.js` (run via `node --test *.test.js`).
- Add `server/tsconfig.json` + `typescript` and `@types/*` devDependencies +
  `typecheck` npm script.
- Update doc references (CLAUDE.md) from `index.js` to `index.ts`.

Out of scope:
- `server/mcp/` (independent ESM package, no dependency on index).
- Splitting index into modules (keeps established single-file design).
- Converting test files to TypeScript.

## Key constraints (verified empirically on Node v24.15)
- CommonJS `.ts` works: `require`, `module.exports`, `__dirname`,
  `require.main === module` all function; no experimental warnings.
- A top-level `import type { ... }` does NOT flip the file to ESM — stays CJS.
  Value imports must remain `require(...)`.
- `require('./index.ts')` resolves only with the explicit `.ts` extension;
  extensionless does not resolve. So test imports need the `.ts` suffix.
- Native `better-sqlite3` and `as` casts work under type-stripping.
- Must avoid non-erasable TS (enums, namespaces, parameter properties).

## Steps
1. Write `server/index.ts`: port `index.js` verbatim, add interfaces
   (`Feed`, `FeedItem`, `Article`, DB row shapes) and annotate functions,
   route handlers (`import type { Request, Response, NextFunction }`), and
   prepared-statement results with `as` casts.
2. `git rm server/index.js` (replaced by `.ts`).
3. Update test files: `require('./index.js')` → `require('./index.ts')` in
   `feed.test.js`, `coindesk.test.js`, `sspai.test.js`, `poller.test.js`,
   `content.test.js`.
4. `server/package.json`: `main` → `index.ts`; add `typecheck` script and
   devDependencies (`typescript`, `@types/node`, `@types/express`,
   `@types/compression`, `@types/cors`, `@types/jsdom`, `@types/better-sqlite3`,
   `@types/xml2js`, `@types/supertest`).
5. Root `package.json`: `server` script `node index.js` → `node index.ts`.
6. Add `server/tsconfig.json` (`noEmit`, `allowJs` off, strict, CommonJS module).
7. Update launchd plist program argument `index.js` → `index.ts`.
8. Update CLAUDE.md references.
9. `cd server && npm install`; run `npm run typecheck` and `npm test`; run the
   server once to confirm boot.

## Risks & Open Questions
- Production `/usr/local/bin/node` must be ≥ 22.18 / 24 for type-stripping —
  flag to user; cannot verify the deploy host from here.
- Library type friction under `strict` may require narrowing/`as` casts.
- Tests hit live network (sspai/reddit/coindesk) — may be flaky offline;
  `poller.test.js` + `content.test.js` are hermetic (TEST_DB) and are the
  real regression signal.

## Estimated Complexity
Medium — one large file converted in place plus mechanical entry-point updates;
risk is contained by the existing hermetic test suite and the `typecheck` gate.

## Outcome
Done as planned. Summary of actual changes:
- `server/index.js` → `server/index.ts` (657 lines), fully annotated. Kept
  CommonJS: `require`/`module.exports`/`__dirname`/`require.main` unchanged;
  only `import type { Request }` and inline `import('pkg')` type references used,
  so Node keeps the file as CJS. Library values loaded via
  `const x = require('x') as typeof import('x')`.
- Behaviour-preserving code tweaks forced by `strict`: Date subtraction/compares
  now use `.getTime()`; `PromiseSettledResult` filtered with a type guard;
  DB `.get()/.all()` results cast to row interfaces; `req.ip ?? ''`.
- Added `server/tsconfig.json` (`noEmit`, strict, `moduleResolution: bundler`)
  and devDeps: `typescript`, `@types/*`, plus `supertest` (was used by
  `content.test.js` but never declared — surfaced when npm pruned it).
- Scripts: `server/package.json` `main` → `index.ts`, added `start` and
  `typecheck`; root `server` script → `node index.ts`.
- Test imports updated `./index.js` → `./index.ts` (extensionless does not
  resolve under Node's TS loader; tests stay `.js`).
- Updated launchd plist program arg → `index.ts`; updated CLAUDE.md.

Validation: `npm run typecheck` clean; 20/20 hermetic tests pass
(`poller.test.js` + `content.test.js`); `node index.ts` boots natively
(reached `app.listen`, only blocked by the already-running prod service on
3002). Network tests (live feeds) not run to completion — flaky/slow and not a
signal for this change.

Deviations: none material. Note for deploy — prod node is v24.15
(supports type-stripping); `deploy.sh` needs no change (it rsyncs the whole
`server/` dir and `bun install --production` correctly skips the TS devDeps,
which are not needed at runtime).
