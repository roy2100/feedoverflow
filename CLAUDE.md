# CLAUDE.md

## Commands

```bash
npm run dev              # Go server (3002) + client (3000) in parallel
npm run server / client  # individual processes (server → `cd server-go && go run .`)

npm install && cd client && npm install   # client + root tooling deps (Go backend uses go modules)

# Tests
cd server-go && make check      # fmt-check + lint (vet + staticcheck) + offline unit tests
cd server-go && make test-int   # live-network suites (build tag itest)
cd client && npm test            # vitest suites (jsdom)

# Lint & format (client only, via oxc; Go backend uses gofmt/staticcheck through its Makefile)
npm run fmt && npm run lint:fix   # after changes — auto-format + auto-fix
npm run fmt:check && npm run lint # before commit — must both pass clean

# Deploy (full runbook: docs/rathole-vps-tunnel.md)
./scripts/deploy.sh              # build + sync to ~/Deploy/feedoverflow, kickstart the launchd service
launchctl kickstart -k "gui/$(id -u)/com.feedoverflow.app"   # force restart
tail -f ~/Deploy/feedoverflow/logs/app.log    # structured NDJSON (slog)
```

Do not silence lint errors or rewrite business logic just to make `lint` pass — if a correctness
rule flags real intent, surface it rather than auto-suppressing.

## Workflow

Single-person project — edit and commit directly on `main`. No feature branches or PRs required.

## Deployment

Single-user macOS app, publicly reachable at `https://rss.royl.uk:8443` via a rathole tunnel to
an Aliyun VPS running Caddy (TLS). The app itself runs on the Mac; the VPS only fronts it.
Session-cookie auth (`AUTH_USER`/`AUTH_PASS`) gates public access. Local-only traffic (and the MCP
server) goes through the unauthenticated loopback API on `127.0.0.1:4002` (`LOCAL_API_PORT`),
which is never tunneled. Full setup/runbook: `docs/rathole-vps-tunnel.md`.

## Architecture

Three-panel RSS reader: **sidebar → article list → reader pane**.

The app durably persists **every** fetched article (not just starred ones) into `article_states`
for offline stats/research — every fetch path (on-demand reads, background refresh, startup
warming, the poller) goes through one shared chain (`internal/cache` → `internal/store`), with no
per-feed item cap and a 2GB DB size cap. There's no read/unread feature — articles only carry a
starred flag.

```
server-go/          Go backend (cgo binary, port 3002 — chi router, mattn/go-sqlite3)
  main.go           entrypoint: config → DB → logger → both listeners → background jobs
  internal/config   env config (PORT, LOCAL_API_PORT, RSS_DB, AUTH_*, DB_MAX_SIZE_MB, PUSH_SUBJECT, ...)
  internal/httpapi  Server struct + NewPublicRouter / NewLocalRouter; per-domain handlers
  internal/mcp      MCP server (Streamable HTTP) — 13 tools, mounted on NewLocalRouter only
  internal/db       SQLite open (WAL), schema + migrations
  internal/auth     session login/logout + per-request gate + login rate-limit
  internal/store    article_states writes — persist upserts, feed writes, adopt-orphans
  internal/cache    refreshFeed fetch chain + ensureFresh (TTL) + startup warming
  internal/favicon  favicon_cache read-through
  internal/jobs     poller, maintenance (orphan cleanup + size-cap + VACUUM), resource monitor
  internal/push     Web Push (VAPID) sender for per-feed update notifications
  internal/translate OpenAI-compatible client for per-feed LLM title translation
  internal/feed     gofeed RSS wrapper
  internal/ssrf     SSRF guard for outbound content/favicon fetches
client/             Vite + React + TypeScript (port 3000)
  src/App.tsx       top-level layout/auth/audio owner
  src/store.ts      zustand store — feeds/articles/views + all fetch logic
  src/types.ts      shared client types, mirrors server-go/internal/model
  src/components/   FeedSidebar, ArticleList, ArticleReader, ModalOverlay, AddFeedModal, ManageFeedsModal, ManageCollectionsModal, SettingsModal, PodcastPlayer, LoginForm
  src/pages/        mobile single-pane wrappers (FeedsPage, ListPage, ReaderPage)
```

The mobile panel (订阅源 → 列表 → 文章) is plain React state in `App.tsx`, deliberately **not**
mirrored into browser history: iOS's edge-swipe-back is a native gesture-driven animation of a
history navigation that we then animated a second time from `popstate`, and that coupling caused a
long run of iOS-only rendering bugs (frozen overlapping panels, dead scroll, buried deep-link
stacks). Back is the in-app ← arrow only; the edge-swipe does nothing. Don't reintroduce
`pushState` here — see `docs/plan-drop-mobile-history.md`.

Every modal renders through `ModalOverlay` — one portal, one backdrop, one Escape handler, one copy
of the keyframes. Backdrop dismiss requires the backdrop to own **both** the `pointerdown` and the
`click`: a `click` targets the nearest common ancestor of press and release, so drag-selecting text
out of the panel and letting go on the backdrop reports the backdrop as `e.target` and an
`e.target === e.currentTarget` check alone closed the modal mid-selection. `onEscape` exists for
modals whose Escape unwinds an inner step first (ManageCollectionsModal's sub-editor); the backdrop
still closes outright.

TypeScript, type-stripped by Vite/Vitest. `npm run typecheck` (`tsc --noEmit`, in `client/`) is
the type gate — Vite does not type-check.

**Data flow:** `store.ts` owns app state (`feeds`, `collections`, `articles`, `selectedView`,
`selectedArticle`, `starredCount`); components subscribe via `useStore`. `selectedView`:
`{ type: 'all' | 'today' | 'starred' | 'podcast' | 'feed' | 'collection' | 'search', feed?,
collection?, query?, scope? }`. Star uses optimistic updates — mutate local state immediately,
fire-and-forget POST to sync.

**Vite proxy:** `/api/*` → `http://localhost:3002`.

**UI signal-to-noise:** don't repeat information the current context already makes obvious (e.g.
hide the per-row feed name when a single feed is selected), keep labels in one consistent
language, drop stale/redundant chrome.

### Server (`server-go/`)

- **Two listeners share the same handlers.** `NewPublicRouter()` (all interfaces, auth-gated,
  static+SPA) and `NewLocalRouter()` (loopback `127.0.0.1:LOCAL_API_PORT`, no auth, also mounts
  `/mcp`). Auth is decided by which socket the request arrived on, not a header.
- RSS fetched via `gofeed` through the refresh chain: fetch upstream → persist all items into
  `article_states` → stamp `feeds.last_fetched_at`. No separate items cache — list endpoints read
  straight from `article_states`. `ensureFresh` per request: fresh → serve as-is; stale →
  background refresh; brand-new feed → await one fetch. Persist **upserts** on `article_id`:
  re-fetched items refresh content fields but never touch `is_starred`; `feed_id`/`feed_name`/
  `feed_url` are insert-only, so a live feed never re-homes an article. `content_updated_at`
  stamps only on genuine content changes.
- Deleting a feed purges its non-starred rows; starred rows keep `feed_url`, so re-adding the same
  URL re-adopts them (`adopt-orphans`).
- Maintenance (`internal/jobs/maintenance.go`): orphan cleanup (non-starred rows whose feed is
  gone) + size cap (`DB_MAX_SIZE_MB`, default 2GB — trims oldest non-starred articles to 90%, then
  `VACUUM`s). Starred articles are never deleted.
- Article IDs: `md5(link || title+pubDate)` truncated to 12 chars.
- Podcast playback position lives in `article_states.play_position` (whole seconds), not in the
  browser — a resume survives a data wipe and follows the listener across devices. Every write is
  an `UPDATE`: a progress ping carries only an id and a number, so inserting on a miss would mint
  a title-less article row that shows up in every list. Non-NULL means "worth resuming" — the
  *client* decides an episode is finished (only the audio element knows its real duration) and
  sends `DELETE`, so the server needs no duration column. `GET` is capped at the 200 most recent
  (`play_updated_at`): the client hydrates an in-memory map from it once at startup, because the
  resume seek must stay synchronous with the play gesture. Rationale:
  `docs/plan-podcast-progress-sqlite.md`.
- **Collections** (`合集`) are saved queries over `article_states`, not sources: a collection is
  the *union* of its rules, each rule `feed AND include AND NOT exclude`, and it fetches nothing —
  no cache entry, no poller slot, no freshness handling, exactly like `/api/all-articles`. That
  one shape expresses every case: merge N feeds (N rules, feed only), take one category out of
  each feed (feed + keyword), or follow a keyword across every feed (keyword only). The endpoint
  runs **one query per rule and merges in Go** — the same fan-out `digest` mode uses — instead of
  assembling an OR-chained `WHERE`, which keeps the SQL static; taking `ListLimit` per rule is
  exact, since the newest N of a union is contained in the union of the per-rule newest N. Results
  are deduped by `article_id` (rules may overlap). Keywords match title + summary but **not**
  `content`: a term buried in the body is not a category signal. A **Latin-script keyword matches
  whole words only** — SQLite's `LIKE` is a case-insensitive substring test, so `%AI%` also
  collects "said"/"maintaining"/"available"; SQL does the coarse `LIKE` pass (a superset, and the
  part SQLite can index) and Go re-checks survivors with an ASCII `\b` regexp. CJK keywords keep
  plain substring matching — the script has no word separators, so a boundary rule would break
  them — and Go's `\b` is ASCII-only, so `AI模型发布` still matches `AI`. A word-boundary
  *exclusion* is deliberately **not** applied in SQL: `LIKE` over-matches, and a row SQL drops can
  never be recovered. A rule constraining neither feed nor keyword is rejected (400) rather than
  executed as a full-table scan. Deliberately *not*
  wired to push — a collection is a lens, not a source, and the feeds under it already notify.
  Rationale: `docs/plan-collections.md`.
- **List queries never name the `content` column.** Every list caller passes
  `withContent=false`, so the body was read and thrown away; `store.articleColsNoContent`
  substitutes a literal in the same scan position, leaving `scanArticleRows` and every `Row`
  consumer untouched. Two reads keep the real column: `Starred` and `ArticleByID` (the push
  deep link), pinned by `TestContentCarryingReads`.
  What this does and does not buy (measured, 20k rows × 10 kB bodies): it does **not** cut
  page reads — 2516 page-cache misses either way. `content` is the 8th column and the list
  SELECT still needs `author`/`audio_url`/`is_starred`/`content_updated_at`, which are stored
  *after* it, so SQLite walks the whole overflow chain regardless. What it saves is
  materializing megabytes of body text into Go strings per request: ~10 ms → ~3 ms warm on a
  500-row window. Doing the same for `summary` is worthless (measured: identical misses,
  identical time) — it is a few hundred bytes sharing the row's first page.
  The unclaimed win is column order: a query touching **nothing stored after `content`** drops
  to 516 misses, 5× fewer. Realizing it needs a covering index over the list columns (or
  moving bodies to their own table), neither of which is free — see the perf note in
  `docs/plan-collections.md`.
- Outbound content/favicon fetches pass through an SSRF guard (`internal/ssrf`).
- Push has two independent axes, deliberately not merged: `feeds.push_enabled` says *this source
  is worth a notification* (global — one row, every device shares it), while `push_subscriptions`
  says *this device receives* (one row per device; the sender fans out to all of them). A device
  that never subscribed — a second browser, or the same phone after reinstalling the PWA — sees
  every bell as on and receives nothing, which is why ManageFeedsModal carries an explicit
  device row above the list. Deregistering is only ever that control's job: it must not be a side
  effect of toggling a feed, or one device could silently cut off all the others.
- Push notifications are opt-in per feed (`feeds.push_enabled`, default off) and are sent **only
  from the poller** — an on-demand refresh triggered by someone reading the app must never notify
  about the article they are looking at. "New" is decided by the `feeds.last_notified_ts`
  watermark, not by inspecting what the persist chain inserted, so the fetch/persist transaction
  and `internal/cache` are untouched by the feature. The selection is bounded at both ends
  (`watermark < pub_ts <= now`) and the watermark is stamped from the rows actually selected:
  `dates.PubTs` passes upstream dates through unclamped, so a future-dated item would otherwise
  push the watermark ahead and swallow every real update until real time caught up. Enabling push
  seeds the watermark to now, so switching it on never replays the backlog. At most 3 articles
  per feed per poll are pushed, one notification each; a busier poll simply drops the surplus —
  never a "有 N 篇新文章" summary, which is an unread count, the one thing this reader has no
  concept of. Rationale + manual test steps: `docs/plan-push-notifications.md`.
- **Title translation** is **one global switch** (`llm_config.enabled`, default off), deliberately
  *not* a per-feed opt-in. A per-feed flag would exist to keep Chinese feeds from costing anything,
  and the worker's local Han-ratio check (>30% Han → skipped, never sent) already does that with no
  clicks; the residual case ("this English feed I read fine") did not justify a column, a PATCH
  field and a control on every row. The API key is the *capability* and the switch is the *intent* —
  both required, the same split as the VAPID keypair versus a push opt-in.
  It runs in its own 30s worker (`internal/jobs/translator.go`), *not* off the poller the way push
  does. Push must fire only from the poller because an on-demand refresh must never notify about the
  article being read; translation has the opposite requirement, so one standalone worker covers
  every fetch path (poller, `EnsureFresh`, warming) and keeps upstream latency off the request path
  entirely.
  **One title per request, never a batch**: batching saves ~¥0.02/day and buys the one failure that
  must not happen — a model that drops an element in a batched response shifts every following
  translation onto the wrong article, silently and permanently. One title per request makes that
  structurally impossible and deletes the index-keyed protocol, the tolerant JSON decoder and the
  partial-failure semantics a batch would need. Batching one *feed's* titles together was
  reconsidered as a way to give the model context and rejected again: what a headline needs is its
  own article, not its siblings.
  The request carries **the article's feed name and summary** alongside the title
  (`translate.Request`, assembled by `userMessage` into 来源/摘要/标题 lines). Most bad translations
  are the model not knowing what the piece is about; the summary answers that per-row, so it works
  without batching. All of it is attacker-controlled feed text and all of it stays in the *user*
  message — that separation, not its length, is the injection mitigation, and `clean`'s growth check
  still measures the answer against the **title**, so a model talked into echoing the body is
  rejected as "nothing usable".
  The system prompt is ~250 tokens (role, style rules, four examples) and must stay **byte-identical
  across calls**: it is the cacheable prefix, and at that size it clears DeepSeek's 64-token block
  floor that the previous 53-token prompt missed. Nothing per-article may move into it — that
  fragments the cache per feed for nothing. Caching was never the goal, only what makes a prompt
  long enough to fix the register problem (翻译腔) cost nothing; the whole prompt prices at well
  under ¥1/month either way, which is why the earlier compression was the wrong trade.
  Rationale: `docs/plan-translation-context.md`.
  Pending work is `title_zh IS NULL AND pub_ts > now − 24h`. That **one** bound carries three jobs:
  it keeps `title_zh IS NULL` from matching the entire historical table (every pre-existing row has
  it NULL); it decides how far back switching on reaches; and it decides when to stop retrying a row
  that keeps failing — a failed request writes nothing and the queue is newest-first, so without a
  bound a permanently-failing row would block everything older than it forever. An earlier design
  split the second job onto a watermark stamped at enable time; with both set to 24h the two are
  provably identical (the watermark equals `now − 24h` when stamped and is overtaken immediately),
  so it was deleted rather than kept as a knob that could only hold one value.
  **This bound is not a spending control** — it permits work, it does not create it. In steady state
  everything inside it settles within minutes, so the pending set is empty whatever the value. It
  bites only on a real backlog: an outage longer than a day, or a newly added feed, whose
  older-than-24h items stay in their original language.
  `title_zh` is three-valued — NULL = pending, `''` = settled with no translation (already Chinese,
  or nothing usable came back), non-empty = the translation. Only the worker distinguishes NULL from
  `''`; every reader treats both as "show the original". A failed *request* writes nothing and is
  retried; a successful one always settles the row, so no counters or give-up rules are needed.
  The endpoint is any OpenAI-compatible `/chat/completions` (`llm_config`, editable at runtime from
  SettingsModal — the worker re-reads it every tick). `base_url` arrives over HTTP, so it is
  restricted to https or loopback and upstream response bodies are never echoed to the client. The
  original title is never overwritten in the data. The **list shows only the translation** — a muted
  second line doubled every row's height and was clipped mid-word, and scanning is the one place the
  original earns nothing. **ArticleReader shows both**, which is where a suspect translation is
  actually checked, and search matches `title` and `title_zh` alike.
  Future article-level AI output (body translation, summaries) should **not** follow this shape:
  those are only needed for what you actually open, so they belong on-demand from the reader, and
  their output belongs in a side table — a body-sized column on `article_states` is exactly what the
  `articleColsNoContent` perf note warns about.
  Rationale: `docs/plan-title-translation.md`.
- Auth: when `AUTH_USER`/`AUTH_PASS` are set, every `/api/*` request on the public router requires
  a valid session cookie (no localhost bypass — gated by socket, not IP). Login is rate-limited.

**SQLite tables:**
- `feeds(id, name, url, last_fetched_at, push_enabled, last_notified_ts)`
- `collections(id, name, position, created_at)` + `collection_rules(id, collection_id, feed_id, include, exclude)` — saved multi-feed streams
- `article_states(article_id, feed_id, feed_name, feed_url, title, link, pub_date, pub_ts, summary, content, author, audio_url, audio_duration, is_starred, updated_at, content_updated_at, play_position, play_updated_at, title_zh)` — durable record of every fetched article
- `settings(key, value)` — e.g. `rsshub_base_url`
- `sessions(token, created_at)` — 30-day TTL
- `favicon_cache(domain, image, content_type, fetched_at)` — 30-day positive / 1-day negative TTL
- `push_subscriptions(endpoint, p256dh, auth, user_agent, created_at)` — one row per registered device
- `push_keys(id, public_key, private_key)` — the single VAPID keypair; deliberately *not* in
  `settings`, which `GET /api/settings` serializes wholesale
- `llm_config(id, base_url, api_key, model, enabled)` — the single translation endpoint + the
  global on/off switch; out of `settings` for the same reason as `push_keys`

**API:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/feeds` | list feeds |
| POST | `/api/feeds` | add feed |
| POST | `/api/feeds/import-opml` | bulk import from OPML |
| PATCH | `/api/feeds/:id` | rename feed and/or toggle `push_enabled` (both fields optional) |
| DELETE | `/api/feeds/:id` | remove feed + purge its non-starred articles |
| GET | `/api/feeds/:id/articles` | articles for one feed, up to 500; `?summary=1` |
| GET | `/api/collections` | list collections with their rules |
| POST | `/api/collections` | create a collection (name + rules) |
| PATCH | `/api/collections/:id` | rename and/or replace rules (both fields optional) |
| DELETE | `/api/collections/:id` | remove a collection (articles untouched) |
| GET | `/api/collections/:id/articles` | the collection's merged stream; `?summary=1` |
| GET | `/api/all-articles` | merged + sorted, up to 500; `?mode=latest\|digest`, `?summary=1` |
| GET | `/api/today` | today's articles, same `?mode=` toggle; `?summary=1` |
| GET | `/api/starred` | starred articles |
| GET | `/api/podcasts` | episodes with a non-empty `audio_url` |
| GET | `/api/starred/count` | badge count |
| POST | `/api/articles/star` | upsert `is_starred` |
| GET | `/api/articles/:id` | one article (content included) — used only by the push deep link |
| GET | `/api/articles/:id/content` | cached full content |
| GET | `/api/fetch-content?url=` | Readability extraction |
| GET | `/api/favicon?domain=` | cached feed favicon (BLOB) |
| GET\|POST | `/api/current-article` | in-memory "currently open" article (for MCP) |
| GET | `/api/podcast-progress` | recent playback positions, id → seconds (200 newest) |
| POST | `/api/podcast-progress` | upsert one episode's position |
| DELETE | `/api/podcast-progress/:id` | forget one episode's position |
| GET\|PATCH | `/api/settings` | read/update settings |
| POST | `/api/login` `/api/logout` | session auth |
| GET | `/api/auth-check` | whether the request is authed |
| GET | `/api/push/key` | VAPID public key (generated on first call) + device count |
| POST | `/api/push/subscribe` `/api/push/unsubscribe` | register/drop this device's push endpoint |
| GET\|PATCH | `/api/llm/config` | translation endpoint/model/`enabled` + whether a key is stored (`key_set`; the key itself is never returned) |
| POST | `/api/llm/config/test` | translate one fixed string through the stored config |

### MCP server (`internal/mcp`)

Mounted at `POST /mcp` on `NewLocalRouter` only (loopback, no auth by design). 13 tools, each a
thin self-call into `http://127.0.0.1:LOCAL_API_PORT/api/...` (`internal/mcp/client.go`) rather
than duplicating `internal/httpapi`'s handler logic: `list_feeds`, `add_feed`, `rename_feed`,
`delete_feed`, `import_opml`, `get_all_articles`, `get_today_articles`, `get_starred_articles`,
`get_feed_articles`, `get_starred_count`, `toggle_star`, `get_current_article`,
`fetch_article_content`.

The three list tools (`get_all_articles`, `get_today_articles`, `get_feed_articles`) call their
endpoint with `?summary=1`; the two cross-feed ones also pin `?mode=digest`. Digest does not
shrink the response (both modes cap at 500) — it changes who fills it, so one high-volume feed
can't take the whole window and read to an agent as "the other feeds published nothing". The list endpoints strip `summary` and `content` by default because
the browser's list panes render neither and 500 summaries per request is pure payload; an MCP
client has no reader pane to open, so bare titles give it nothing to decide on. `?summary=1` adds
back only the RSS summary — never `content`, which stays behind `fetch_article_content` /
`/api/articles/:id/content`. `get_starred_articles` needs no flag: `/api/starred` has always
returned both.
