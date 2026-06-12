# Plan: Backend favicon cache (SQLite BLOB)

## Goal
Stop the client from hitting `https://www.google.com/s2/favicons` on every sidebar
render. Add a backend endpoint that fetches each feed's favicon once, stores the bytes
in SQLite, and serves them from cache with long HTTP cache headers. This removes the
per-load external dependency (slow / blockable / privacy leak) and survives browser
cache clears.

## Scope
Included:
- New `favicon_cache` SQLite table (BLOB storage).
- New `server/favicon.ts` module + `GET /api/favicon?domain=<host>` route.
- Client `FeedIcon` in `FeedSidebar.jsx` and `ManageFeedsModal.jsx` point `src` at the
  new endpoint.
- Tests for the endpoint (cache hit/miss, bad input, negative cache).

Out of scope:
- File-on-disk caching (rejected in favor of SQLite BLOB per user choice).
- Pruning favicon rows via the maintenance size-cap (blobs are tiny, negligible).
- Changing the upstream source away from Google s2.

## Steps
1. **Schema** (`db.ts`): add
   `favicon_cache(domain TEXT PRIMARY KEY, image BLOB, content_type TEXT, fetched_at INTEGER)`.
   A NULL `image` row = negative cache (upstream fetch failed), retried after a short TTL.
2. **Module** (`favicon.ts`): `getFavicon(domain)` —
   - validate `domain` is a plausible hostname; reject otherwise.
   - look up row; serve if fresh (positive TTL 30d, negative TTL 1d).
   - on miss/expired: `fetch` Google s2 (`sz=64`), read bytes + content-type, upsert,
     return. On fetch failure: upsert negative row, signal 404 to caller.
3. **Route** (`app.ts`): `GET /api/favicon?domain=` → calls `getFavicon`, sets
   `Cache-Control: public, max-age=604800` (overrides the global `/api` `no-store`),
   sends bytes or `404` (so the client's existing `<Rss>` `onError` fallback kicks in).
4. **Client**: both `FeedIcon` components swap the Google URL for
   `/api/favicon?domain=${domain}`. Keep the existing `onError → <Rss>` fallback.
5. **Tests** (`favicon.test.ts`): bad domain → 400; miss populates cache; second call is a
   DB hit (stub/spy on fetch); negative cache returns 404. Stub `fetch` to avoid network.
6. **Docs**: update `CLAUDE.md` table list + API table; append Outcome here.

## Risks & Open Questions
- Google s2 returns a generic globe for unknown domains instead of erroring, so a "real"
  missing-favicon is cached as that globe. Acceptable — matches today's behavior.
- Auth: `/api/favicon` is gated like other `/api/*` for non-localhost. The sidebar only
  renders when logged in and `<img>` carries the session cookie, so no special-casing.
- BLOBs count toward `DB_MAX_SIZE_MB`; with a few dozen feeds at a few KB each this is
  well under a tenth of a percent of the 500MB cap. No pruning added.

## Estimated Complexity
Low–Medium — one new small module + table + route + two one-line client edits + tests.

## Outcome
Implemented as planned.
- `db.ts`: added `favicon_cache(domain, image BLOB, content_type, fetched_at)`.
- `favicon.ts`: `getFavicon(domain)` with positive 30-day / negative 1-day TTL, hostname
  validation, Google s2 (`sz=64`) upstream, NULL-image negative cache on failure.
- `app.ts`: `GET /api/favicon?domain=` — `Cache-Control: public, max-age=604800`, sends
  bytes or `404` (client `<Rss>` fallback). `400` on invalid/missing domain.
- Client: `FeedIcon` in `FeedSidebar.jsx` + `ManageFeedsModal.jsx` now point at the
  endpoint; existing `onError → <Rss>` fallback unchanged.
- `favicon.test.ts`: 5 tests (invalid domain, miss→persist, cache hit suppresses refetch,
  negative cache, empty body). All pass; `tsc --noEmit` clean.

Deviation: none. Note `feed.test.ts` fails with a live-feed `429` in this environment —
pre-existing and unrelated (it hits a real network feed).
