# Plan: Collections (合集) — saved multi-feed article streams

## Goal

Let the reader define a named stream that merges articles from several feeds, optionally
narrowed by keyword — e.g. "AI 播客" = (Feed A where title/summary contains "AI") ∪
(Feed B, everything) ∪ (any feed where title contains "LLM").

## Key premise

`article_states` already holds **every** fetched article from every feed in one flat table.
A collection is therefore not a fetch pipeline, a cache entry, or a poller target — it is a
**saved query over one table**. Nothing in `internal/cache`, `internal/jobs`, `internal/feed`
or the persist chain changes.

Second premise: `/api/all-articles` and `/api/today` never call `EnsureFresh` — they read
straight from the table and let the poller keep it current. A collection endpoint does the
same, so freshness needs no new logic either.

## Model

A collection is an **OR of rules**; each rule is `feed AND include AND NOT exclude`.

```sql
CREATE TABLE collections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER, created_at INTEGER
);
CREATE TABLE collection_rules (
  id            INTEGER PRIMARY KEY,
  collection_id TEXT NOT NULL,
  feed_id       TEXT,   -- NULL = any feed
  include       TEXT,   -- NULL/'' = no keyword requirement
  exclude       TEXT    -- NULL/'' = no exclusion
);
```

That one shape covers every case asked for:

| Intent | Rules |
|---|---|
| Merge feeds A+B+C | 3 rules, `feed_id` only |
| Category X of A, category Y of B | 2 rules, `feed_id` + `include` |
| "AI" from everywhere | 1 rule, `feed_id = NULL`, `include = 'AI'` |

Keyword matching is `LIKE` over **title + summary** — deliberately not `content`
(`/api/search` does include content, but a body-text mention is not a category signal and
would make rules match far too much).

## Query strategy — no dynamic SQL

Run **one query per rule and merge in Go**, the same fan-out/merge `digest` mode already
uses in `Server.listArticles` (`FeedIDs` → `NewestByFeed` per feed → `ByPubDateDesc` → cap).
Each rule query is `NewestByFeed` plus optional `LIKE` predicates. Then dedupe by
`article_id`, sort `pub_ts DESC`, cap at `articles.ListLimit`.

This is exact, not approximate: the global newest-N of a union is always contained in the
union of the per-rule newest-N.

## Scope

**In**

1. `internal/db` — two tables (additive, idempotent, in `InitSchema`).
2. `internal/store/collections.go` — CRUD + `RuleArticles` query.
3. `internal/httpapi/collections.go` — `GET/POST /api/collections`,
   `PATCH/DELETE /api/collections/{id}`, `GET /api/collections/{id}/articles`.
4. Client — `Collection`/`CollectionRule` types, `View.type = 'collection'`, store state +
   CRUD, sidebar section, a `ManageCollectionsModal` for create/edit/delete.
5. Go tests for the rule query + handlers; client test for the store's collection load.
6. `CLAUDE.md` — schema, API table, architecture note.

**Out**

- Push notifications for collections. A collection is a lens, not a source; the underlying
  feeds already notify, and a second axis would double-notify.
- MCP tools. Can be added later as thin self-calls, like every other tool.
- A boolean query DSL. OR-of-(feed AND keyword) is the whole language.
- `?mode=digest`. The two-mode toggle exists because 全部/今日 span every feed; a collection
  is already a hand-picked, small set.
- Collections never own articles: deleting one touches zero `article_states` rows.

## Steps

1. Schema migration in `db.InitSchema` (+ index on `collection_rules.collection_id`).
2. `store`: `ListCollections`, `CollectionWithRules`, `InsertCollection`, `UpdateCollection`,
   `ReplaceRules`, `DeleteCollection`, `RuleArticles`.
3. `httpapi/collections.go` + route registration in `mountAPIRoutes`.
4. Go tests.
5. Client types + store.
6. `FeedSidebar` section + `ManageCollectionsModal` + `App.tsx` wiring (`viewTitle`).
7. `make check`, `npm test`, `npm run typecheck`, `fmt`/`lint`.
8. Update `CLAUDE.md`; branch `feat/collections` → PR.

## Risks / open questions

- A rule with no `feed_id` and no `include` selects the entire table — reject at the API
  (a rule must constrain on at least one axis) rather than silently building a slow "全部".
- Global keyword rules (`feed_id = NULL`) are an unindexed `LIKE` scan, exactly like
  `/api/search` today. Acceptable at this DB size; noted, not optimized.
- Deleting a feed leaves rules pointing at a dead `feed_id`. They simply match nothing.
  Cleaning them up silently would destroy user intent, so rules are left alone and the
  editor shows the dangling id as unknown.

## Complexity

**Medium** — many small files, but no new subsystem: one schema addition, one query pattern
already present in the codebase, and a list view the client renders with existing components.

## Outcome

Implemented as planned, with these specifics worth recording:

- **Rule validation** landed as `store.Rule.Normalized()` + `Valid()`: rules are trimmed,
  and a rule constraining nothing (no feed, no include) is rejected with 400 rather than
  becoming a full-table scan. A collection must carry at least one valid rule.
- **`ReplaceRules` is a transaction** (`DELETE` + re-`INSERT` inside `BEGIN`), so a failed
  edit can't leave a collection with a truncated rule set. `PATCH` only replaces rules when
  the request actually sends a `rules` array — a rename-only body leaves them untouched,
  the same optional-pointer contract `patchFeed` uses for `name`/`push_enabled`.
- **Dedupe is by `article_id`** in `collectionArticles`: overlapping rules (e.g. a feed rule
  plus a global keyword rule that both match one article) would otherwise show it twice.
- **`DELETE` on a collection also deletes its rules** explicitly rather than relying on
  `ON DELETE CASCADE` — the connection DSN doesn't enable `foreign_keys`, so the declared
  FK is documentation, not enforcement.
- **The LIKE escaper moved** from `httpapi/search.go` into `store.LikeEscape`. Rules and
  search both feed raw user input into `LIKE`, and a second copy of an escaping routine is
  exactly the kind of thing that drifts out of sync.
- **Client**: `store.loadArticles` gained one branch for the collection URL;
  `ArticleList`/`ArticleReader` needed zero changes because the payload is the same
  `Article[]`. `hideFeedName` stays false for collections — a merged stream is exactly
  where the source name carries information. The editor re-checks the "rule constrains
  nothing" rule locally before POSTing, so the failure is explained next to the fields
  that caused it instead of arriving as a banner after a round trip.
- Scoped search deliberately does **not** gain a collection scope. `scopeFromView` still
  returns only starred/feed; scoping search to a collection would mean intersecting a
  saved query with a text query, which the single-`WHERE` search handler can't express.

Deviations: none of substance. The `position` column is written (create order) but no
reorder UI ships — the sidebar lists collections in that order and the modal edits in place.

### Follow-up: word-boundary matching for Latin keywords

Shipped after first use. The original `LIKE '%kw%'` is a substring test, and SQLite's `LIKE`
is case-insensitive over ASCII, so an `AI` rule also collected "said", "maintaining" and
"available" — noise that made any Latin-script keyword useless. CJK was unaffected: the
script has no word separators, so substring *is* the right test there.

- SQL keeps the coarse `LIKE` pass (a superset of the answer, and the part SQLite can
  index); `store.refine` re-checks the survivors in Go with a case-insensitive ASCII `\b`
  regexp built by `wordBoundary`.
- Go's `\b` is ASCII-only, which is exactly right: in `AI模型发布` the CJK character is not
  an ASCII word character, so the boundary still holds and the row matches. A SQL-side
  `' ' || title || ' ' LIKE '% AI %'` trick would have silently missed it.
- Only edges that are themselves word characters get anchored, so `C++`, `.NET` and `#tag`
  work — `\b` after `+` would demand a word character there and never match.
- A word-boundary **exclusion is not applied in SQL at all**. `LIKE` over-matches, so an
  SQL exclusion would drop rows the boundary rule keeps, and a row SQL never returns cannot
  be recovered in Go.
- Known bound, accepted: the `LIMIT` applies to the coarse pass, so a keyword with heavy
  false-positive noise can under-fill the 500-row window and lose *older* true matches.
  Narrowing the rule with a feed constraint is the workaround; paging the coarse pass would
  mean holding several thousand rows (each carrying `content`) in memory, which this app's
  memory budget does not justify.

#### If that bound ever needs closing

Both options below make `LIMIT` exact by doing the boundary test *inside* the query, so the
500 rows SQLite returns are already the answer. Deferred, not rejected — the bound needs an
ASCII keyword whose rule scope yields >500 coarse hits that are mostly false, and the
collections in use are CJK, where there are no false positives at all.

**Preferred — register a Go function as a SQLite scalar function.** `mattn/go-sqlite3`
v1.14.47 exposes `(*SQLiteConn).RegisterFunc`, so `db.Open` can install `word_match(text,
kw)` through a `ConnectHook` on a named driver, and the rule query becomes
`WHERE title LIKE ? AND word_match(title, ?)` — `LIKE` still narrows the candidates,
`word_match` decides, and the existing `wordBoundary` stays the single definition of the
semantics (CJK and ASCII branches both live in Go). Costs: `db.Open` is the connection entry
point for the *whole* app, and both pools would move to the custom driver — a blast radius
larger than the feature; one cgo callback per candidate row, with SQLite free to reorder the
`AND` so the `LIKE` prefilter is not a guaranteed reduction; and the compiled regexp needs
caching per keyword or every row recompiles it.

**Rejected alternative — GLOB character classes, no Go involved.** `upper(' '||title||' ')
GLOB '*[^A-Z0-9]AI[^A-Z0-9]*'` was measured to give semantics identical to the Go `\b`
version, CJK adjacency included (`AI模型发布` matches, since `[^A-Z0-9]` treats 模 as one
non-word character) and case handled by `upper()`. It loses on maintenance, not capability:
GLOB has no `ESCAPE` clause, so a keyword containing `*`, `?` or `[` needs a second,
hand-rolled escaper living beside `LikeEscape` — the exact duplication that escaper was
consolidated to remove — and CJK keywords would still have to branch back to `LIKE`, leaving
two matching paths in SQL.

## Perf note: what the list-query column set actually costs

Measured on a synthetic 391 MB DB shaped like the live one (20k rows, 10 kB bodies, the real
column order), 500-row window, page-cache misses from `.stats on`:

| SELECT | misses | warm |
|---|---|---|
| includes `content` | 2516 | ~10 ms |
| skips `content`, still takes `author` (current) | 2516 | ~3 ms |
| also skips `summary` | 2516 | ~3 ms |
| touches nothing stored after `content` | **516** | ~1 ms |

Three conclusions, the first of which corrects the reasoning in commit `c457d95`:

1. **Dropping `content` from the SELECT does not reduce page reads.** `content` is the 8th
   column and the list rows still need `author`, `audio_url`, `is_starred` and
   `content_updated_at`, all stored after it, so SQLite walks the overflow chain either way.
   The 3× it does buy is the cost of materializing megabytes of body text into Go strings —
   real, but CPU and allocation, not I/O.
2. **Doing the same for `summary` buys nothing.** A few hundred bytes sharing the record's
   first page: identical misses, identical time. Not worth the flag plumbing that `?summary=1`
   would force through six store functions.
3. **The 5× is in column order, not column count.** A query needing nothing stored after
   `content` reads one page per row instead of the whole overflow chain. Two ways to get
   there, neither free: a covering index over the list columns (fat index, write amplification
   on every persist), or moving bodies into their own table keyed by `article_id` (clean —
   only `Starred` and `ArticleByID` read them — but a migration over the live 460 MB DB).
   Unmeasured against the real DB; do that before committing to either.
