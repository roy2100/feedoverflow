# Backend Fetch & Cache Logic

A reference for how the server fetches feeds from upstream, what it caches, where it
persists, and how the read endpoints stitch those layers together.

> **Design goal:** durably persist *every* fetched article (not just starred) into
> `article_states` for offline statistics/research. That is why every fetch path shares one
> persist chain, there is no per-feed item cap on persistence, and the DB size cap is 2 GB.
> There is no read/unread feature — articles carry only a starred flag.

## The three stores

| Store | Table | Role | Persistence | TTL |
|-------|-------|------|-------------|-----|
| **Feed cache** | `feed_cache` | Read-through cache of the latest parsed RSS item **metadata** per feed (article bodies stripped) | Transient (just a cache) | 5 min (`CACHE_TTL`) |
| **Article states** | `article_states` | Durable record of every fetched article + starred flag + cached content | Permanent (the source of truth for history) | none (size-capped) |
| **Favicon cache** | `favicon_cache` | Per-domain favicon BLOBs | Long-lived | 30 d positive / 1 d negative |

Two more network paths have no cache table: on-demand full-content extraction
(`/api/fetch-content`, Readability) and the favicon upstream fetch (Google s2).

## The upstream fetch primitive

Everything that touches the network for feeds goes through `parse-url.ts → parseURL(url, signal)`:

- `resolveUrl()` (in `articles.ts`) rewrites `rsshub://…` URLs to the configured
  `rsshub_base_url` before fetching.
- `fetchFeedXml()` does `fetch()` with a `User-Agent`, a hard **10 s** `AbortSignal.timeout`,
  combined (`AbortSignal.any`) with any caller signal (e.g. request-close) so a slow feed
  aborts even if the client stays connected.
- `rss-parser` parses the XML, mapping `content:encoded → contentEncoded`.

## The shared fetch chain — `refreshFeed` (`cache.ts`)

`refreshFeed(feed, signal?)` is the single chain every fetch path routes through:

1. `parseURL` the feed from upstream.
2. `persistItems(feed, items, feedName)` — `INSERT OR IGNORE` **all** items (full bodies)
   into `article_states` (`articles.ts`).
3. Write the `feed_cache` row (`INSERT OR REPLACE`, `fetched_at = now`) with item bodies
   (`content` / `contentEncoded`) **stripped** — the cache only carries list metadata; bodies
   live in `article_states.content`.

Steps 2–3 run in **one transaction**, so a `persistItems` failure can't leave a body-less
cache row whose body never reached `article_states`. Because persistence lives in step 2,
**every** path that fetches persists: on-demand cold misses, stale background refresh, startup
warming, and the poller. `INSERT OR IGNORE` makes it idempotent — a re-persist never
overwrites an existing row or its starred flag.

### Read-through wrapper — `getCachedFeed` (on-demand)

`getCachedFeed(feed, signal)` is what the read endpoints call:

1. **Miss** (no row): `await refreshFeed(feed, signal)` synchronously (fetch + cache +
   persist), return its items.
2. **Hit, fresh** (`age < 5 min`): return cached items, no network.
3. **Hit, stale** (`age ≥ 5 min`): return the stale cached items **immediately**, and kick
   off a **background** `refreshFeed()` (fire-and-forget) to refresh + persist for next time.

So a request never waits on a refresh except on a cold miss.

`feed_cache` stores: `feed_id`, `feed_name` (from parsed `<title>`, falling back to the
configured name), `items_json` (full parsed item array), `fetched_at` (epoch ms).

### Startup warming (`startCacheWarming`, called from `index.ts` after bind)

- Stale cached feeds → refreshed in the background (also persists, via `refreshFeed`).
- Uncached feeds → warmed via `Promise.allSettled`; `cacheReady` flips `true` when done
  (or immediately if nothing was uncached). `cacheReady` is surfaced in
  `/api/all-articles` and `/api/today` so the client can tell a cold start from "no items".
- Skipped entirely under `TEST_DB`.

## Background poller (`poller.ts`)

The poller guarantees periodic refresh + persistence of **all** feeds, regardless of whether
the user opens them. Started from `index.ts` **after the port binds** (so a failed bind never
mutates the DB), skipped under `TEST_DB`.

- **First pass** (5 s after start) and **recurring** (`pollAllFeeds`, every **15 min** =
  `POLL_INTERVAL`): poll every feed with a 2–5 s random jitter between each to avoid hammering
  hosts in lockstep.
- Each `pollFeed` is just `await refreshFeed(feed)` — the same chain as on-demand. No separate
  persist step, no read-state bookkeeping.

> **Two refresh mechanisms, one chain.** The 5-min read-through (on-demand, keeps feeds you
> open fresh on the request path) and the 15-min poller (blind, guarantees every feed is
> persisted) both call `refreshFeed`. Phase 2 (`docs/plan-unify-fetch-persist.md`) proposes
> retiring `feed_cache` entirely once `article_states` is trusted as the complete record.

## How read endpoints combine the layers

All article-list endpoints follow the same pattern: **live cache items + persisted history,
deduped by id, sorted by pubDate desc.** Article ids are
`md5(link || title+pubDate).slice(0,12)` (`makeId`), so the same article from cache and
from `article_states` collides and dedups correctly.

| Endpoint | Live source | History source | Merge |
|----------|-------------|----------------|-------|
| `GET /api/feeds/:id/articles` | `getCachedFeed` top 50 | all `article_states` for the feed | live wins; history backfills items aged out of the feed |
| `GET /api/all-articles` | `getCachedFeed` top 5 / feed | — | cache only, merged across feeds |
| `GET /api/today` | `getCachedFeed`, filtered to today | — | cache only |
| `GET /api/search` | — | SQL `LIKE` over `article_states` (title/summary/content, limit 200) | DB only, re-sorted by parsed date, top 100 |
| `GET /api/starred` | — | `article_states WHERE is_starred=1` | DB only |
| `GET /api/starred/count` | — | `article_states` aggregate | DB only |

`enrich()` (`articles.ts`) is the glue: it takes raw `RssItem`s, computes the id, joins
the current `is_starred` from `article_states` in one `IN (…)` query, and shapes the
`Article`. `withContent: false` truncates summary to 300 chars and drops body content
(list views); `withContent: true` keeps full content (persistence, search).

## Content lookup

The list endpoints send `content: ''`; the reader fetches it lazily via
`GET /api/articles/:id/content` → `lookupContent(articleId)`, which reads
`article_states.content` (or empty). Every fetched item is persisted there with its body, so
there is no `feed_cache` fallback — the cache no longer stores bodies.

Star writes (`/api/articles/star`) backfill content via the same `lookupContent` before
`saveState()` upserts the row — so starring an article captures its body so it survives
feed removal.

`GET /api/fetch-content?url=` is a separate on-demand path (reader's "full article" mode):
fetches the page with a browser UA + 15 s timeout, then runs **jsdom + Readability**
(imported lazily — ~100 MB resident, only loaded on first use). Not cached.

## Favicon cache (`favicon.ts`)

`getFavicon(domain)` is read-through against `favicon_cache`:

- Validates the domain against a conservative hostname regex first.
- Fresh hit → return the BLOB (or `null` for a fresh **negative** row).
- Miss/stale → fetch `google.com/s2/favicons?sz=64`. Success stores the BLOB
  (positive, 30 d TTL); any failure stores a `NULL`-image **negative** row (1 d TTL) so we
  don't refetch a broken icon every request.
- `GET /api/favicon` always returns **200**: a real icon (with a 7-day `Cache-Control`
  overriding the global `/api` no-store) or the default placeholder SVG (1-day TTL).

## Cache invalidation

- `PATCH /api/settings` runs `clearCache.run()` (`DELETE FROM feed_cache`) — changing
  `rsshub_base_url` rewrites feed URLs, so all cached items must be dropped.
- `feed_cache` is otherwise self-invalidating via TTL; there is no manual per-feed purge.
- `favicon_cache` only self-invalidates via TTL.

## Maintenance (`maintenance.ts`)

Runs at poller startup, then every **24 h** (`MAINTENANCE_INTERVAL`). Wrapped in
try/catch so a bad pass never crashes the process.

- `cleanupOrphans()` — deletes non-starred `article_states` rows whose `feed_id` is gone.
  Starred orphans are kept on purpose (a starred article survives feed removal).
- `enforceSizeCap()` — if logical DB size (`page_count * page_size`) exceeds
  `DB_MAX_SIZE_BYTES` (default **2 GB**, override `DB_MAX_SIZE_MB`), delete the **oldest
  non-starred** articles (ordered by parsed `pub_date`, falling back to `updated_at`) down
  to **90 %** of the cap, then `VACUUM`. Starred articles are never deleted. Deletes in
  chunks of 500 to stay under SQLite's bound-parameter limit.

> Note the tension with the research-persistence goal: the cap still trims oldest non-starred
> articles when exceeded, so retention is bounded at 2 GB, not infinite. Full retention would
> need periodic export.

## Constants

| Constant | Value | Where |
|----------|-------|-------|
| `CACHE_TTL` | 5 min | `cache.ts` |
| `POLL_INTERVAL` | 15 min | `poller.ts` |
| `MAINTENANCE_INTERVAL` | 24 h | `poller.ts` |
| Feed fetch timeout | 10 s | `parse-url.ts` |
| `fetch-content` timeout | 15 s | `app.ts` |
| Favicon positive TTL | 30 d | `favicon.ts` |
| Favicon negative TTL | 1 d | `favicon.ts` |
| `DB_MAX_SIZE_BYTES` | 2 GB | `config.ts` |
| Persistence depth | all items (no cap) | `articles.ts` |

## End-to-end flow

```
                         ┌──────────────────────────────────────────┐
                         │ upstream RSS  (parseURL, 10s timeout)      │
                         └──────────────┬─────────────────────────────┘
                                        │ refreshFeed()
              ┌─────────────────────────┴───────────────────────────┐
              │                                                      │
   on-demand (getCachedFeed)                          background poller (15 min)
   from read endpoints                                + startup warming
              │                                                      │
              ▼                                                      ▼
        ┌───────────┐  persistItems(): INSERT OR IGNORE (all items, bodies)  ┌──────────────┐
        │ feed_cache │◀── one txn ──────────────────────────────────────────▶│ article_states│
        │ (5min,meta)│                                                        │  (durable)    │
        └─────┬─────┘                                                         └──────┬───────┘
              │ list metadata                                      history / bodies  │
              └───────────────┬────────────────────────────────────────────┘
                              ▼  enrich() + dedupById + sort
                     read endpoints → client
```
