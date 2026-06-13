# Plan: Migrate client to TypeScript

## Goal
Convert the Vite + React client (`client/src/**`, currently `.jsx`/`.js`) to
TypeScript so component props, store state, and API/data shapes are statically
typed. Vite (esbuild) and Vitest already type-strip TS natively, so there is no
runtime/build concern — the new value is a `typecheck` gate (`tsc --noEmit`)
that actually verifies the annotations, mirroring the backend migration
(`plan-ts-backend.md`). Strictness matches the server (`strict: true`).

## Scope
Included:
- Rename every source module: `.jsx` → `.tsx` (components/pages/App/main),
  `.js` → `.ts` (store, AudioContext, faviconDomain, hooks). Add full type
  annotations to props, state, refs, and the zustand store.
- New `client/src/types.ts` with shared `Feed`, `Article`, `View`, `MobilePage`,
  and `AudioCtxValue` types (Feed/Article kept in sync with `server/types.ts`).
- New `client/src/vite-env.d.ts` declaring `vite/client` types and the
  `__BUILD_DATE__` define injected by `vite.config`.
- Convert tests: `__tests__/ArticleReader.test.jsx` → `.test.tsx`,
  `store.test.js` → `.test.ts`, `setup.js` → `setup.ts`. Fixtures get string
  `Feed.id`s to match the typed shape.
- Convert `vite.config.js` → `vite.config.ts`; update `index.html` script src
  `main.jsx` → `main.tsx`; update `setupFiles` path in the Vitest config.
- Add `client/tsconfig.json` (+ `tsconfig.app.json`, `tsconfig.node.json`),
  `typecheck` npm script, and devDeps: `typescript`, `@types/react`,
  `@types/react-dom`, `@types/node`.

Out of scope:
- Server (already TS).
- Any behaviour, styling, or UI change — pure type/extension migration.
- Switching state libs, routing, or build tooling.

## Key constraints
- React 18 → `@types/react@^18` / `@types/react-dom@^18`, `jsx: "react-jsx"`.
- Vitest `globals: true` → tsconfig `types` includes `vitest/globals` and
  `@testing-library/jest-dom` so `describe/it/expect`/matchers type-check.
- zustand v5 typed via `create<StoreState>()(...)`.
- `View` modelled as `{ type: 'all'|'today'|'starred'|'feed'; feed?: Feed }`
  (optional `feed`), accessed via optional chaining everywhere — avoids
  discriminated-union narrowing churn while staying honest about absence.
- No emit: typecheck is `tsc -b` against the project-reference tsconfigs.

## Steps
1. Add `client/tsconfig.json` (references), `tsconfig.app.json` (src, strict,
   `react-jsx`, `noEmit`, test type libs), `tsconfig.node.json` (vite config).
2. `client/src/types.ts` + `vite-env.d.ts`.
3. Convert leaf utilities first: `faviconDomain.js`→`.ts`,
   `hooks/useIsMobile.js`→`.ts`, `AudioContext.js`→`.ts`.
4. Convert `store.js`→`store.ts` with a typed `StoreState` (note: current
   `store.js` lacks `starredCount`/the read actions the tests/pages reference —
   reconcile the store surface with its consumers during typing).
5. Convert components (`.jsx`→`.tsx`) with prop interfaces: ArticleList,
   ArticleReader, FeedSidebar, AddFeedModal, ManageFeedsModal, SettingsModal,
   PodcastPlayer, LoginForm.
6. Convert pages and `App.jsx`/`main.jsx` → `.tsx`.
7. Convert tests + `setup.ts`; fix `Feed.id` fixtures to strings.
8. `vite.config.js`→`.ts`; `index.html` src → `main.tsx`.
9. `client/package.json`: add `typecheck` script + devDeps; `cd client && npm install`.
10. Run `npm run typecheck`, `npm test`, `npm run build` in `client`; then repo-root
    `npm run fmt` + `npm run lint:fix`, and `fmt:check` + `lint` clean.

## Risks & Open Questions
- `strict` will surface real nullability gaps (e.g. `view.feed`, audio refs,
  fetch JSON typed as `unknown`/`any`). Resolve by narrowing, not by loosening
  config. Fetch responses will be typed via small response interfaces or `as`.
- Store/consumer mismatch: pages (`FeedsPage`, `ListPage`) and `store.test`
  reference `starredCount` and read-tracking that the live `store.js` does not
  implement. Typing forces this inconsistency into the open — will align the
  store to what consumers expect rather than inventing new behaviour.
- oxlint runs with the `typescript` plugin already; converted files must pass
  `correctness` with no new suppressions.

## Estimated Complexity
Medium-High — ~3600 lines across ~20 files, mechanical renames but real
strict-null annotation work, plus a pre-existing store/consumer gap to reconcile.
Contained by the existing Vitest suite and the new `tsc` gate.

## Outcome
Done as planned. All client source converted to `.ts`/`.tsx` under `strict: true`;
`npm run typecheck` (`tsc -b`) clean, `npm run build` (now `tsc -b && vite build`)
green, `oxfmt`/`oxlint` clean. Test baseline preserved: **29 pass, 2 fail**.

Key decisions / deviations:
- **Behavior-preserving, not bug-fixing.** The 2 failing tests are pre-existing
  and unrelated to types: the live `store.ts` never implements `starredCount`
  bookkeeping that `store.test` and `FeedsPage` assume. `starredCount` is typed
  as inert state (initialised 0, untouched by `toggleStar`) to keep the runtime —
  and therefore the failing baseline — identical. Left for a separate fix.
- **`Field` autofocus (AddFeedModal).** The old code passed `ref` to a plain
  function component, which React 18 silently drops — autofocus was already
  broken. Converting it to `forwardRef` (the only way to typecheck a ref prop)
  incidentally makes autofocus work. Minor, intended-looking improvement.
- **Strict-null touch-ups (runtime-identical):** `audioRef.current` guarded with
  `if (!audio) return` / optional chaining; `Date` subtraction via `.getTime()`;
  DOM `style.opacity` assigned strings not numbers; `catch (err)` → `(err as Error)`;
  fetch JSON stays `any` (DOM `Response.json()` returns `any`), so data shapes flow
  without casts.
- **Dead code removed:** `FeedsPage` no longer forwards an unused `starredCount`
  prop to `FeedSidebar`.
- **Types:** `src/types.ts` mirrors `server/types.ts` for `Feed`/`Article`; `View`
  uses optional `feed` accessed via optional chaining (no discriminated-union churn).
- **Tooling:** project-reference tsconfigs (`tsconfig.json` → `app` + `node`);
  `vite.config.ts`; `index.html` → `main.tsx`; `*.tsbuildinfo` gitignored;
  devDeps `typescript`, `@types/react`, `@types/react-dom`, `@types/node`.
- **Deploy:** `deploy.sh` runs `bun install` (with devDeps) before `bun run build`,
  so `tsc` is present. Side effect: a type error now blocks the deploy build
  (previously the client was never type-checked).

Open follow-up: implement `starredCount` bookkeeping in `toggleStar` (and likely a
`/api/starred/count` fetch on `init`) to make the 2 baseline-failing tests pass.
