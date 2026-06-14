# Plan: Unify fetch→persist chain, drop read/unread, raise DB cap

## Goal

Three coupled changes, all in service of repositioning the app as a durable article store
for statistical research:

1. **Unify** the two upstream-fetch paths (on-demand `getCachedFeed` reads and the background
   poller) onto one shared chain — **fetch → write feed_cache → persist to `article_states`** —
   so *every* successful fetch persists, not just the poller's.
2. **Remove the read/unread feature** entirely. It is already dormant — the client never marks
   articles read (a store test even asserts it never calls `/api/articles/read`), and the
   `isRead` field / `--dot-unread` var are unused in the UI. Dropping it also erases the
   trickiest behavioral risk of the unify work (the `markRead`-on-new-feed rule).
3. **Capture more, longer**: remove the per-feed 50-item persistence cap and raise the DB size
   cap to 2 GB. Record the research-persistence goal in `CLAUDE.md`.

## Scope

**Included**
- One canonical fetch chain (`refreshFeed`) writing both `feed_cache` and `article_states`,
  used by on-demand cold-miss, background refresh, startup warming, and the poller.
- Full removal of read/unread: `is_read` column, `enrich` read flag, `/api/articles/read`,
  `/api/unread-counts`, poller `markRead` plumbing, MCP `mark_article_read` tool + `isRead`
  schema field, client `isRead`/`--dot-unread`, and the now-moot client store test.
- Remove the `slice(0, 50)` persistence cap — persist all parsed items per feed.
- Raise `DB_MAX_SIZE_MB` default 500 → 2048 (2 GB).
- Record "persist articles for statistical research" as a feature in `CLAUDE.md`.
- Update `docs/backend-fetch-cache.md` and the `CLAUDE.md` API/schema/MCP tables.

**Out of scope**
- The **starred** feature stays (is_starred column, `/api/starred*`, starred-survives-feed-
  removal). Only read/unread is removed.
- Display/response slices in read endpoints (`/api/feeds/:id/articles` top-50 live merge,
  `/api/all-articles` top-5) — UI limits, unchanged.
- Keeping the two **entry policies** distinct on purpose: reader stays TTL-gated via
  `getCachedFeed`; poller stays force-fetch all-feeds on a timer. We unify the *write chain*,
  not the *trigger policy* — fully collapsing the poller into TTL-gated reads would weaken the
  all-feeds persistence guarantee for feeds the user never opens.
- Export/stats tooling itself — this plan only guarantees the data is captured.

## Steps

1. **Remove read/unread from the persistence + query core (`articles.ts`).**
   - `enrich`: drop `is_read` from the state query and the `isRead` field it sets.
   - `upsertState` / `saveState`: drop the `is_read` column and the `is_read` patch param;
     `StatePatch` becomes starred-only.
   - Move `insertPolledArticle` + `persistPolled` here from `poller.ts` (breaks the circular
     import when `cache.ts` persists); rename to `persistItems`, **with no `markRead` param** —
     the INSERT no longer has an `is_read` column. Keep a `persistPolled` alias re-exported via
     `app.ts` for existing test imports, or update those tests (decide in step 8).

2. **Make `fetchAndCache` the canonical chain (`refreshFeed`).** After writing `feed_cache`,
   call `persistItems(feed, items, feedName)` over **all** items (drop `slice(0, 50)`). Rename
   `fetchAndCache → refreshFeed`. `getCachedFeed`'s cold-miss and stale-background-refresh
   branches now persist for free.

3. **Simplify the poller (`poller.ts`).** `pollFeed` becomes `await refreshFeed(feed)`. Delete
   `insertPolledArticle`/`persistPolled` (moved in step 1), the `markRead` params, and the
   first-pass `hasStates`/`markRead: !hasStates` logic — none of it has meaning without
   read state. Keep the timer/jitter/all-feeds orchestration.

4. **Remove the API surface (`app.ts`).** Delete the `/api/articles/read` and
   `/api/unread-counts` routes. Drop `isRead` from the three `ArticleStateRow → Article`
   response mappings (feeds/:id/articles, starred, search).

5. **Remove the MCP surface (`mcp.ts`).** Delete the `mark_article_read` tool and the `isRead`
   field from the article schema. Tool count drops 14 → 13.

6. **Remove client remnants.** Drop `isRead` from `client/src/types.ts`, the unused
   `--dot-unread` var from `index.css`, the `isRead` fixture in `ArticleReader.test.tsx`, and
   the now-moot `'不调用 /api/articles/read'` assertion in `store.test.ts`.

7. **Schema + config.**
   - `db.ts`: drop `is_read` from the `article_states` CREATE, and add a migration
     `ALTER TABLE article_states DROP COLUMN is_read` (SQLite ≥ 3.35; guarded like the existing
     `audio_*` migrations). **Open question** below — drop vs. leave dormant.
   - `config.ts`: default `|| 500` → `|| 2048`; update the comment.

8. **Tests + gates.** Update `poller.test.ts`, `content.test.ts`, `search.test.ts` to drop
   `is_read`/`isRead` references. Add: (a) on-demand `getCachedFeed` miss persists rows to
   `article_states`; (b) a removed-feature regression check (no `/api/articles/read`,
   `/api/unread-counts`). Run `npm run fmt`, `lint:fix`, then `fmt:check` / `lint` /
   `typecheck` clean before commit.

9. **Docs.** Update `CLAUDE.md` (Architecture/Deployment prose: research-persistence goal,
   2 GB cap, every fetch path persists; API table: remove the two routes; schema: remove
   `is_read`; MCP: "14 tools" → "13"). Update `docs/backend-fetch-cache.md` to match (unified
   chain, no 50-cap, 2 GB default, no read state).

## Risks & Open Questions

- **Drop the `is_read` column or leave it dormant?** Physically dropping (SQLite
  `DROP COLUMN`, supported ≥ 3.35) gives a clean schema but is the one hard-to-revert step and
  briefly rewrites the table. Leaving the column unused is zero-risk but leaves dead schema.
  **Recommend dropping** — the feature is gone and the column is meaningless for stats.
  Confirm before step 7.
- **Cap vs. research-durability tension.** The 2 GB cap still deletes oldest non-starred
  articles when exceeded — retention is bounded, not infinite. If full history matters, the
  real answer is periodic export (out of scope). Flagging so the cap isn't mistaken for
  permanent retention.
- **Write cost on the request path.** On-demand cold misses now persist synchronously, and
  removing the 50-cap makes a pathological mega-feed write larger. One `INSERT OR IGNORE`
  transaction under WAL — cheap; background refresh/warming are off the request path.
- **Test import churn.** `persistPolled` is re-exported via `app.ts` for tests — alias it to
  `persistItems` or update the imports; decide in step 1/8.

## Estimated Complexity

**Medium.** Read/unread removal is wide but shallow (mechanical deletions, no UI rework since
the client is already read-agnostic), and it simplifies the unify work rather than adding to
it. The real care is in the migration decision (step 7) and the persist-timing tests (step 8).

---

# Phase 2: Slim, then (optionally) retire `feed_cache`

> Deferred — do **not** start until Phase 1 has landed and `article_states` is proven to be a
> complete superset of every fetched feed's items (persist-on-every-fetch + no 50-cap), since
> Phase 2 stops trusting `feed_cache` for article bodies (2a) and eventually for reads (2b).

After Phase 1, `feed_cache` holds two distinct kinds of data:

1. **Heavy — article bodies** (`content` / `contentEncoded` in `items_json`). Now 100%
   redundant with `article_states.content`: `refreshFeed` writes the cache row and
   `persistItems` in the same call, so any body in the cache is also in `article_states`.
2. **Light — the freshness timestamp (`fetched_at`) + the current-feed item list** (title,
   link, pubDate, summary, author, enclosure) used by the debounce gate and the live-merge.

Phase 2 is split so the big, low-risk win (drop the redundant bodies) lands first, and the
larger architectural change (remove the table entirely) stays optional.

---

## Phase 2a — slim `feed_cache` to metadata; bodies come from `article_states` (recommended)

### Goal

Stop storing article bodies in `feed_cache`. The body lives only in `article_states.content`
(the "content state"). `feed_cache` keeps just the lightweight list fields + `fetched_at`, so
it shrinks dramatically (bodies are the bulk of `items_json`) and the body duplication is gone.
The table, TTL gate, and live/history merge all stay — so **no freshness-gate migration and no
read-semantics change**.

### Scope

**Included**
- In `refreshFeed`, strip `content` / `contentEncoded` from items before
  `JSON.stringify` into `feed_cache` (keep `summary` / `contentSnippet` for the 300-char list
  snippet).
- Remove the now-dead `lookupContent` → `feed_cache.items_json` body fallback.
- Remove the now-redundant `/api/search` live-cache body scan arm (the SQL `LIKE` over
  `article_states` already covers bodies).

**Out of scope**
- The `feed_cache` table, the TTL gate, and the read-endpoint merge — all unchanged.

### Steps

1. **Strip bodies on write.** In `refreshFeed`, map items to drop `content`/`contentEncoded`
   before caching. Persist (`persistItems`) still runs on the full items with `withContent: true`,
   so `article_states.content` keeps the body. Document the ordering: cache-write then persist
   in one call; consider wrapping both in a single transaction so a `persistItems` failure
   doesn't leave a body-less cache row whose body never made it to `article_states`.

2. **Drop the dead body fallback.** Remove the `feed_cache` branch in `lookupContent`
   (`articles.ts`) — body now always resolves from `article_states.content`.

3. **Simplify search.** Delete the live-cache scan arm in `/api/search`; keep the
   `article_states` `LIKE` query. (`getCachedFeed` is no longer needed there.)

4. **Tests + docs.** Rewrite the `content.test.ts` "from `feed_cache`" cases to seed
   `article_states` instead. Update `docs/backend-fetch-cache.md` (feed_cache stores metadata
   only; bodies via content state) and `CLAUDE.md` schema note.

### Risks & Open Questions

- **Cache/persist consistency.** Bodies in `article_states` now depend on `persistItems`
  succeeding whenever a cache row is written. If `setCacheRow` succeeds but `persistItems`
  throws, that feed's new bodies wait for the next refresh. Mitigate by wrapping the two writes
  in one transaction (step 1) and/or persisting before caching.
- **List snippet source.** `summary`/`contentSnippet` is kept in the cache; if a feed puts its
  whole body in `summary` it stays heavy. Acceptable — the dominant `content`/`contentEncoded`
  fields are what's stripped.

### Estimated Complexity

**Low.** A field strip on write plus two dead-code removals; captures the main storage win
without touching the freshness gate or read semantics.

---

## Phase 2b — retire `feed_cache` entirely (optional)

> Reassess the need for this only after 2a ships — with bodies gone, the remaining `feed_cache`
> payload is tiny, so 2b's marginal benefit may not justify its risk. Likely skippable.

### Goal

Remove the `feed_cache` table altogether. Its only remaining unique value is `fetched_at` (the
debounce timestamp); relocate that to a per-feed `last_fetched_at`, serve reads from
`article_states`, and delete the cache layer.

### Scope

**Included**
- Replace `feed_cache.fetched_at` with a per-feed `last_fetched_at` marker.
- Re-point `/api/feeds/:id/articles`, `/api/all-articles`, `/api/today`, `/api/search` at
  `article_states`, with a background `refreshFeed` trigger when `last_fetched_at` is stale.
- Drop the `feed_cache` table and `cache.ts`'s cache read/write helpers (`clearCache`, the
  cache-row reads); `refreshFeed` + warming stay.

**Out of scope**
- The freshness *policy* (5-min staleness, force-fetch poller) — unchanged, only its storage
  moves.

### Steps

1. **Add `last_fetched_at`.** New nullable column on `feeds` (epoch ms) via a guarded
   migration, or a tiny `feed_poll(feed_id, last_fetched_at)` table. `refreshFeed` updates it
   on every successful fetch.

2. **New freshness gate.** Replace `getCachedFeed`'s TTL-on-`feed_cache.fetched_at` check with
   one on `last_fetched_at`: stale → fire-and-forget `refreshFeed(feed)`; null (never fetched)
   → fetch synchronously. Reads always return from `article_states` immediately.

3. **Collapse the read endpoints.** Each becomes "query `article_states` + trigger the gate":
   `/api/feeds/:id/articles` (all rows for the feed, `pub_date` desc), `/api/all-articles`
   (newest N per feed), `/api/today` (filtered to today), `/api/search` (already `LIKE`-only
   after 2a). The live+historic merge/dedup disappears.

4. **Delete dead code.** Remove `feed_cache` from `db.ts`, the cache-row helpers + `clearCache`
   from `cache.ts`, and the `PATCH /api/settings` → `clearCache` call (nothing to clear).

5. **Tests + docs.** Update endpoint tests to seed `article_states`; rewrite the
   `docs/backend-fetch-cache.md` read-through sections as the `last_fetched_at` gate and drop
   `feed_cache` from the `CLAUDE.md` schema list.

### Risks & Open Questions

- **Behavioral change — snapshot → accumulated union.** `feed_cache.items_json` reflects the
  *current* feed (items the publisher dropped disappear); `article_states` is append-only, so
  `/api/feeds/:id/articles` shifts from "current feed top N" to "every item ever seen." For a
  research-persistence reader this is the desired direction, but it is a visible change — needs
  sign-off.
- **Completeness dependency.** If Phase 1/2a ever fail to persist some items, 2b reads silently
  miss them (no cache fallback). Validate coverage before starting.
- **`last_fetched_at` storage choice.** Column on `feeds` (simplest) vs. separate table (keeps
  `feeds` config-only). Recommend the column. Decide in step 1.

### Estimated Complexity

**Medium.** Net deletion (a table + four endpoints' merge logic) but relocates the freshness
gate and changes read semantics, so endpoint tests need rework and the snapshot→union change
needs sign-off.

---

## Outcome

**Phase 1 — done (2026-06-14).** Executed as planned, with the open question resolved by
**dropping** the `is_read` column (guarded migration alongside the `audio_*` ones).

- Persist chain unified: `fetchAndCache → refreshFeed` (`cache.ts`) now writes `feed_cache`
  *and* `persistItems` (moved to `articles.ts`, no `markRead`, no 50-cap). `getCachedFeed`
  cold-miss + background refresh and `startCacheWarming` all persist through it; `poller.ts`
  collapsed to `pollFeed → refreshFeed` (dropped `persistPolled`, `markRead`, the first-pass
  `hasStates` logic).
- Read/unread fully removed: `is_read` column + migration, `enrich`/`saveState`/`upsertState`
  flags, `/api/articles/read`, `/api/unread-counts`, MCP `mark_article_read` (14→13 tools) +
  `isRead` schema, client `isRead`/`--dot-unread`, and the moot store test.
- `DB_MAX_SIZE_MB` default 500 → 2048.
- Docs: `CLAUDE.md` (research-persistence goal, unified chain, 2 GB cap, schema, API table,
  MCP count) and `docs/backend-fetch-cache.md` updated.
- Tests retargeted to `persistItems` (`poller.test.ts` rewritten as a DB-only suite;
  `content.test.ts`/`search.test.ts` updated). Gates green: server `tsc` + client
  `typecheck`, 42 server tests, 30 client tests, `fmt:check`, `lint` all pass.

**Deviation:** `poller.test.ts` was rewritten without the HTTP harness (it only existed for
the removed `/api/unread-counts` tests) rather than kept and trimmed. `persistPolled` was not
aliased — tests import `persistItems` from `articles.ts` directly, since they needed rewriting
anyway.

**Phase 2a — done (2026-06-14).** `feed_cache` now stores list metadata only:

- `refreshFeed` (`cache.ts`) strips `content`/`contentEncoded` before writing the cache row,
  and persists full bodies to `article_states`; both writes wrapped in one transaction.
- `lookupContent` (`articles.ts`) simplified to read `article_states.content` only (dropped
  the `feed_cache` fallback + the `feedId` param; callers in `app.ts` updated).
- `/api/search` collapsed to a single `article_states` `LIKE` query (dropped the live-cache
  scan arm; now synchronous).
- Tests: `content.test.ts` seeds `article_states` via `persistItems` and reframes the
  body-source cases; `search.test.ts` comment updated. Gates green: server `tsc`, 42 server +
  30 client tests, `fmt:check`, `lint`.
- Docs: `CLAUDE.md` + `docs/backend-fetch-cache.md` updated.

**Phase 2b — not started (optional, likely skippable).** With bodies gone, the remaining
`feed_cache` payload is tiny, so full retirement's marginal benefit may not justify the
`last_fetched_at` migration + snapshot→union read-semantics change.
