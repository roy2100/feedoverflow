# Plan: Split `server/app.ts` route handlers into `routes/` modules

## Goal
`server/app.ts` is 447 lines holding ~24 route handlers across six unrelated domains
(feeds, settings, content fetch, articles, search, current-article). This makes any
single-domain change require navigating the whole file, and the colocated `routes.test.ts`
mirrors the same monolith. Split the HTTP handlers into per-domain `express.Router()`
modules under `server/routes/`, leaving `app.ts` as a thin assembly file (middleware →
auth → mount routers → MCP → SPA fallback). Behavior, paths, and `export default app`
stay identical, so existing tests keep importing `app` unchanged.

## Scope

**Included**
- Extract route handlers from `app.ts` into `server/routes/*.ts`, one module per domain.
- `app.ts` keeps: imports of express/middleware, `trust proxy`, the middleware stack,
  `registerAuth(app)`, mounting the routers, `registerMcp(app)`, and the `*` SPA fallback.
- Preserve the exact registration ORDER (see Risks) and all route paths verbatim.

**Explicitly out of scope**
- No behavior changes. In particular, the `/api/feeds/:id/articles` unbounded-historic
  query (the 4142-row issue) is NOT touched here — that is a separate decision.
- No service-layer reshuffle: `cache.ts`, `articles.ts`, `favicon.ts`, `auth.ts`, `db.ts`,
  etc. stay where they are (domain logic, already single-responsibility).
- No `controllers/ services/ models/` enterprise layering.
- No moving/renaming of test files (colocation stays). May optionally split
  `routes.test.ts` later, but not in this plan.
- No subdirectory grouping of the non-route modules.

## Current route inventory (from `app.ts`, by existing `── ──` section dividers)

| Section (line) | Routes | Target module |
|---|---|---|
| Feeds (50) | `GET/POST /api/feeds`, `POST /api/feeds/import-opml`, `PATCH/DELETE /api/feeds/:id`, `GET /api/feeds/:id/articles` | `routes/feeds.ts` |
| Settings (128) | `GET/PATCH /api/settings` | `routes/settings.ts` |
| Full content fetch (148) | `GET /api/fetch-content`, `GET /api/favicon` | `routes/content.ts` |
| Articles (205) | `GET /api/all-articles`, `/api/today`, `/api/starred`, `/api/podcasts`, `/api/starred/count`, `POST /api/articles/star`, `GET /api/articles/:id/content`, `GET/POST /api/current-article` | `routes/articles.ts` |
| Search (361) | `GET /api/search` | `routes/search.ts` |

Note: `GET /api/feeds/:id/articles` lives under the Feeds section but is article-flavored.
Keep it in `routes/feeds.ts` to match the current section grouping and avoid a `:id` path
split across modules — minimizes diff and reasoning.

## Steps

1. **Create `server/routes/` directory.**

2. **Create each router module** (`feeds.ts`, `settings.ts`, `content.ts`, `articles.ts`,
   `search.ts`). Each:
   - `import express from 'express';` → `export const router = express.Router();`
   - Move the matching handlers verbatim, changing `app.get(...)` → `router.get(...)`.
   - Move only the imports that module actually uses (each handler's deps are a subset of
     `app.ts`'s current import block: `db`, `articles.ts` helpers, `cache.ts`, `favicon.ts`,
     `parse-url.ts`, `ssrf.ts`, types, plus `crypto`/`xml2js` for feeds' OPML/dedup).

3. **Slim `app.ts`** to assembly only, preserving order:
   ```
   middleware (compression, cors, json, /api no-store, static)
   registerAuth(app)              // login/logout/auth-check + the /api gate
   app.use(feedsRouter)           // mount all five routers
   app.use(settingsRouter)
   app.use(contentRouter)
   app.use(articlesRouter)
   app.use(searchRouter)
   registerMcp(app)
   app.get('*', spa fallback)
   export default app   // unchanged
   ```
   Routers are mounted with full `/api/...` paths inside each module, so mount as bare
   `app.use(router)` (no path prefix) to keep paths identical.

4. **Typecheck + lint + format**: `cd server && npm run typecheck`,
   then `npm run fmt` and `npm run lint:fix` from repo root, then `npm run fmt:check` + `npm run lint`.

5. **Run tests**: `cd server && npm test` (offline node:test suites — `routes.test.ts`,
   `search.test.ts`, `auth.test.ts`, etc. import `app` and must pass unchanged).
   Sanity-check a couple of live endpoints manually if convenient.

6. **Update `CLAUDE.md`** Architecture/tree section: note that `app.ts` is now assembly and
   route handlers live in `routes/`. (Doc-only, after code is green.)

## Risks & Open Questions

- **Registration order is load-bearing.** `registerAuth(app)` (`auth.ts:89`) installs the
  `/api/*` auth gate as middleware; anything mounted AFTER it is gated, login/logout/auth-check
  registered BEFORE it stay reachable. All five routers MUST mount after `registerAuth(app)`
  and before `registerMcp(app)` + the `*` fallback. Getting this wrong silently breaks auth
  or the SPA. Mitigation: keep the exact order in Step 3; `auth.test.ts` covers the gate.
- **`*` SPA fallback must stay last.** Mounting a router after it would never match.
- **Shared `:id` paths.** `GET /api/feeds/:id/articles` and `PATCH/DELETE /api/feeds/:id`
  must live in the same router (feeds) to keep Express matching order intact.
- **Import drift.** Moving handlers can leave unused imports in `app.ts` or miss one in a
  router — `npm run typecheck` + `lint` catch both.
- **Open question (deferred, not blocking):** whether to also split `routes.test.ts` to
  mirror the new modules. Recommend NO for this pass — keep the test surface stable to prove
  the refactor is behavior-preserving; revisit separately.

## Estimated Complexity
Low–Medium. Mechanical move of ~24 handlers with zero logic change; the only real hazard is
preserving middleware/route registration order, which is well-defined and test-covered.

## Outcome

Done as planned. `app.ts` went from 447 → 56 lines (middleware → `registerAuth` → mount five
routers → `registerMcp` → SPA `*` fallback; `export const app` unchanged). Handlers moved
verbatim into `server/routes/{feeds,settings,content,articles,search}.ts`, each an
`express.Router()` carrying full `/api/...` paths and mounted bare via `app.use(router)`.

Deviations:
- `app.ts` exports `export const app` (named), not `export default` — kept the existing named
  export, so `index.ts` and tests import unchanged.
- The in-memory `currentArticle` state moved into `routes/articles.ts` (module-local, only its
  two handlers touch it).
- oxfmt collapsed the multi-line import in `feeds.ts` to one line — cosmetic only.

Verification: `npm run typecheck` clean, `npm run fmt:check` + `npm run lint` clean,
`cd server && npm test` → 82 pass / 0 fail (15 suites). `routes.test.ts` / `search.test.ts` /
`auth.test.ts` pass unchanged, confirming behavior + auth-gate ordering preserved.
