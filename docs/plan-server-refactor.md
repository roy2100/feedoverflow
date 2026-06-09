# Plan: Server Code Reorganization

## Goal
Break `server/index.ts` (696-line monolith) into focused modules following
standard Express project conventions. Each file should have a single
responsibility and import only what it needs. Tests that currently import from
`./index.ts` get updated to the correct module or continue working via
re-exports.

## Scope
**In:** split index.ts into typed modules; update test imports.  
**Out:** no behavior changes, no new features, no route changes.

## Target layout
```
server/
  types.ts      — Feed, Article, ArticleStateRow, FeedCacheRow, StatePatch
  db.ts         — Database instance, migrations, seed data
  parse-url.ts  — parseURL  (already extracted)
  articles.ts   — makeId, dedupById, normalizeDuration, enrich,
                  resolveUrl, lookupContent, upsertState, saveState
  cache.ts      — CACHE_TTL, getCachedFeed, fetchAndCache, clearCache,
                  cacheReady, startCacheWarming
  poller.ts     — persistPolled, pollFeed, pollAllFeeds, startPoller
  auth.ts       — SESSION_TTL, parseCookies, registerAuth(app)
  app.ts        — express app + all route handlers;
                  exports: app, db, makeId, persistPolled  (test surface)
  index.ts      — thin entry point: process.title + app.listen
```

## Steps
1. Create `types.ts` — copy all interfaces out of index.ts
2. Create `db.ts` — Database construction, pragma, migrations, seeds; export `db`
3. Create `articles.ts` — all article helpers; import `db` and types
4. Create `cache.ts` — feed cache layer; import `db`, `parseURL`, `articles`
5. Create `poller.ts` — background poller; import `db`, `cache`, `articles`
6. Create `auth.ts` — auth setup; import `db`; export `registerAuth(app)`
7. Create `app.ts` — express app + all routes wired together; re-export test surface
8. Rewrite `index.ts` — 10-line entry point that calls `app.listen`
9. Update `feed.test.ts` and `sspai.test.ts` to import `parseURL` from `./parse-url.ts`
   (same fix as coindesk/sspai — avoids starting DB + server on import)

## Risks & Open Questions
- ESM live binding: `cacheReady` is exported as a `let` from `cache.ts`; consumers
  get a live binding in ESM so mutation is visible. Verify this works.
- Module caching: tests using `process.env.TEST_DB` rely on dynamic `await import()`
  to get a freshly-initialised DB. Since modules are cached per process, tests
  must remain in separate files (they already are).

## Estimated Complexity
Medium — mechanical split, well-understood boundaries, no logic changes.

## Outcome
Completed as planned. 696-line monolith split into 8 focused modules (286 lines
for app.ts as the largest). `index.ts` reduced to 10 lines. All 20 existing tests
pass; typecheck clean. `feed.test.ts` and `sspai.test.ts` updated to import from
`parse-url.ts` so they no longer hang.
