# Plan: Dedup + serialize feed refreshes to stop event-loop stalls

## Goal
Concurrent list loads (e.g. opening "today" after the app has been idle) stall for ~800ms
because the read endpoints trigger a burst of on-demand background refreshes, and each
refresh's synchronous work (RSS XML parse via `rss-parser` + the `db.transaction` persist on
the 439MB SQLite DB) blocks the single Node thread. `better-sqlite3` is synchronous and Node
is single-threaded, so a fan-out of N stale feeds lands N parse+persist bursts on the event
loop at once, and every concurrent request — even a trivial `starred/count` — queues behind
them. This plan bounds that synchronous work so reads stay fast, without changing what gets
persisted or the "serve stale immediately, refresh in background" UX.

## Diagnosis (already confirmed empirically)
- Any endpoint **serial**: <25ms. `count`/`starred` **concurrent** (no `ensureFresh`): always
  fast. List endpoints **concurrent + feeds fresh**: fast. List endpoints **concurrent + feeds
  stale (after idle)**: ~800ms, dragging every concurrent request.
- Root cause: `today`/`all-articles` call `ensureFresh` for **every** feed (cross-feed
  aggregate → fan-out). Each stale feed fires its own `refreshFeed`. Amplified because
  `today` + `all-articles` + the poller can refresh the *same* feed with no in-flight dedup.

## Scope
### In
- Add single-flight dedup + a small concurrency limit inside `refreshFeed` (`cache.ts`), the
  one function every fetch path funnels through (on-demand `ensureFresh`, poller, startup
  warming). One change fixes all paths.
- Drop the per-caller `AbortSignal` from the shared refresh (a shared in-flight refresh must
  not be aborted by one caller's disconnect). Safe: `parseURL` already enforces a hard 10s
  timeout independent of the caller signal.

### Out (explicitly not doing)
- No `worker_threads`, no language rewrite — the single thread handles the work fine when it's
  not bunched (the poller already proves this with its 2–5s stagger).
- No change to persistence semantics (`persistItems`, upsert, size cap, "persist everything").
- No change to the 5-min TTL (`CACHE_TTL`) or the poller interval.
- The separate `SELECT *`→projected-columns micro-optimization is not part of this change.

## Steps
1. **`cache.ts` — single-flight map.** Keyed by `feed.id`: if a refresh for that feed is
   already running, return the existing promise instead of starting a second. Entry removed on
   settle (`finally`). Dedups today + all-articles + poller hitting the same feed.
2. **`cache.ts` — concurrency limiter.** A tiny slot gate (`REFRESH_CONCURRENCY = 2`) around
   the fetch+persist body so at most 2 refreshes do their synchronous work concurrently. A
   page-load or startup fan-out can no longer bunch every feed's persist into one block; the
   worst-case stall drops to ~2 feeds' worth of work (sub-100ms).
3. **`cache.ts` — refactor `refreshFeed`.** Split the current body into an internal
   `doRefresh(feed)` (acquires a slot, `parseURL` → `db.transaction(persist + setFetchedAt)`,
   releases the slot in `finally`); `refreshFeed(feed)` wraps it with the single-flight map.
   Remove the `signal` parameter.
4. **`cache.ts` — `ensureFresh`.** Drop the `signal` parameter (no longer threaded to the
   shared refresh); logic otherwise unchanged (fresh → no-op; stale → background refresh;
   brand-new no-rows → await one refresh).
5. **Update call sites** (drop the now-removed signal arg, keep each route's own
   `AbortController` for its post-await `aborted` response check):
   - `routes/articles.ts:42` (`all-articles`), `:65` (`today`) — `ensureFresh(f)`
   - `routes/feeds.ts:130` (`feeds/:id/articles`) — `await ensureFresh(feed)`
   - `poller.ts` / `startCacheWarming` already call `refreshFeed(feed)` with no signal — no change.
6. **Verify.** `npm run fmt` + `npm run lint`; `cd server && npm test` (typecheck + offline
   suites); then re-run the concurrent-burst repro against the loopback API (`:4002`) to
   confirm the stall is gone under a fan-out of stale feeds.

## Risks & Open Questions
- **Brand-new feed first load** now goes through the slot gate — if 2 slots are busy it waits
  briefly. Acceptable (rare, first-ever load; 10s parseURL timeout bounds it).
- **Shared refresh ignores caller abort** — a client disconnecting mid-load no longer cancels
  the fetch. Acceptable and arguably better for the "persist everything" goal; the 10s timeout
  still bounds runaway fetches.
- **`REFRESH_CONCURRENCY` value** — 2 bounds the worst-case block to ~2 feeds while still
  letting refreshes make progress. Could tune to 1 (strongest anti-stall, slowest catch-up)
  or 3 if needed; a named constant makes this trivial.
- Poller keeps its own 2–5s stagger for upstream politeness; it now also benefits from the
  single-flight dedup (won't double-fetch a feed an on-demand read is already refreshing).

## Estimated Complexity
Low — localized to `cache.ts` plus three one-line call-site edits; no schema, no API, no client
changes. ~40 lines net.

## Outcome
Implemented as planned. `cache.ts` now has a single-flight `inflight` map keyed by `feed.id`
and a `REFRESH_CONCURRENCY = 2` slot gate (`acquireRefreshSlot`/`releaseRefreshSlot`) wrapping
the fetch+persist in `doRefresh`; `refreshFeed` lost its `signal` param, `ensureFresh` lost its
`signal` param, and the three call sites (`routes/articles.ts` today + all-articles,
`routes/feeds.ts` feeds/:id/articles) drop the arg while keeping their own AbortController for
the post-await response check. Poller and startup warming were unchanged (already call
`refreshFeed(feed)` bare) and now benefit from dedup automatically. `npm run fmt` + `npm run
lint` clean; `cd server && npm test` = 108 pass / 0 fail. Live burst-repro verification against
the deploy is pending (requires deploying the new code, which restarts the production service).
