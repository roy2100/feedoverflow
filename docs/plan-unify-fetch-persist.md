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

# Phase 2: Retire `feed_cache`

> Deferred — do **not** start until Phase 1 has landed and `article_states` is proven to be a
> complete superset of every fetched feed's live items (persist-on-every-fetch + no 50-cap).
> Phase 2's read endpoints stop trusting `feed_cache` and trust `article_states` instead, so
> that completeness must hold first.

## Goal

Once on-demand fetch persists all items to `article_states`, `feed_cache`'s **storage** role
is redundant — `article_states` already holds every live item. The only thing `feed_cache`
still uniquely provides is `fetched_at`: the per-feed "last fetched from upstream" timestamp
that gates the 5-min network-debounce. Move that timestamp onto the feed, serve reads from
`article_states`, and drop the `feed_cache` table entirely.

## Scope

**Included**
- Replace `feed_cache.fetched_at` with a per-feed `last_fetched_at` marker.
- Re-point `/api/feeds/:id/articles`, `/api/all-articles`, `/api/today`, `/api/search` at
  `article_states`, with a background `refreshFeed` trigger when `last_fetched_at` is stale.
- Drop the `feed_cache` table, `cache.ts`'s cache read/write helpers, and the
  `lookupContent` → `feed_cache.items_json` fallback (now dead).

**Out of scope**
- The freshness *policy* (5-min staleness, force-fetch poller) — unchanged, only its storage
  moves.

## Steps

1. **Add `last_fetched_at`.** New column on `feeds` (epoch ms, nullable) via a guarded
   migration, or a tiny `feed_poll(feed_id, last_fetched_at)` table. `refreshFeed` updates it
   on every successful fetch (alongside the `article_states` write).

2. **New freshness gate.** Replace `getCachedFeed`'s TTL-on-`feed_cache.fetched_at` check with
   a check on `last_fetched_at`: if `now - last_fetched_at >= CACHE_TTL`, fire-and-forget
   `refreshFeed(feed)`; if `last_fetched_at` is null (feed never fetched), fetch synchronously
   (the old cold-miss path). Reads always return from `article_states` immediately.

3. **Collapse the read endpoints.** Each becomes "query `article_states` + trigger the gate":
   - `/api/feeds/:id/articles` → all rows for the feed, ordered by `pub_date` desc. The live+
     historic merge/dedup disappears.
   - `/api/all-articles` → newest N per feed from `article_states`.
   - `/api/today` → `article_states` filtered to today.
   - `/api/search` → the SQL `LIKE` arm only; delete the live-cache scan arm.

4. **Delete dead code.** Remove `feed_cache` from `db.ts`; remove `getCachedFeed`/`fetchAndCache`
   cache-row helpers and `clearCache` from `cache.ts` (keep `refreshFeed` + warming, now
   warming just calls `refreshFeed`); drop the `feed_cache` branch in `lookupContent`; remove
   the `PATCH /api/settings` → `clearCache` call (nothing to clear).

5. **Tests + docs.** Update endpoint tests to seed `article_states` instead of `feed_cache`;
   update `docs/backend-fetch-cache.md` and `CLAUDE.md` (drop the `feed_cache` table from the
   schema list, rewrite the "read-through cache" sections as the `last_fetched_at` gate).

## Risks & Open Questions

- **Behavioral change — snapshot → accumulated union.** `feed_cache.items_json` reflects the
  *current* feed (items the publisher dropped disappear); `article_states` is append-only, so
  `/api/feeds/:id/articles` shifts from "current feed top N" to "every item ever seen for this
  feed." For a research-persistence reader this is the desired direction (nothing is lost) and
  the endpoint already merged history — but it is a visible change in what the list shows.
- **Completeness dependency.** If Phase 1 ever fails to persist some live items, Phase 2 reads
  silently miss them (no cache fallback). Validate Phase 1 coverage before starting.
- **`last_fetched_at` storage choice.** Column on `feeds` (simplest) vs. separate table
  (keeps `feeds` purely user-config). Recommend the column unless we want to keep `feeds`
  config-only. Decide in step 1.

## Estimated Complexity

**Medium.** Net **deletion** — removes a table, four endpoints' merge logic, and a
`lookupContent` branch — but it relocates the freshness gate and changes read semantics, so
the endpoint tests need real rework and the snapshot→union change needs sign-off.

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

**Phase 2 — not started.**
