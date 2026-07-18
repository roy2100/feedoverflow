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
./scripts/deploy.sh              # build + sync to ~/Deploy, kickstart the launchd service
launchctl kickstart -k "gui/$(id -u)/com.rss-reader.app"   # force restart
tail -f ~/Deploy/rss-reader/logs/app.log      # structured NDJSON (slog)
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
  internal/config   env config (PORT, LOCAL_API_PORT, RSS_DB, AUTH_*, DB_MAX_SIZE_MB, ...)
  internal/httpapi  Server struct + NewPublicRouter / NewLocalRouter; per-domain handlers
  internal/mcp      MCP server (Streamable HTTP) — 13 tools, mounted on NewLocalRouter only
  internal/db       SQLite open (WAL), schema + migrations
  internal/auth     session login/logout + per-request gate + login rate-limit
  internal/store    article_states writes — persist upserts, feed writes, adopt-orphans
  internal/cache    refreshFeed fetch chain + ensureFresh (TTL) + startup warming
  internal/favicon  favicon_cache read-through
  internal/jobs     poller, maintenance (orphan cleanup + size-cap + VACUUM), resource monitor
  internal/feed     gofeed RSS wrapper
  internal/ssrf     SSRF guard for outbound content/favicon fetches
client/             Vite + React + TypeScript (port 3000)
  src/App.tsx       top-level layout/auth/audio owner
  src/store.ts      zustand store — feeds/articles/views + all fetch logic
  src/types.ts      shared client types, mirrors server-go/internal/model
  src/components/   FeedSidebar, ArticleList, ArticleReader, AddFeedModal, ManageFeedsModal, SettingsModal, PodcastPlayer, LoginForm
  src/pages/        mobile single-pane wrappers (FeedsPage, ListPage, ReaderPage)
```

TypeScript, type-stripped by Vite/Vitest. `npm run typecheck` (`tsc --noEmit`, in `client/`) is
the type gate — Vite does not type-check.

**Data flow:** `store.ts` owns app state (`feeds`, `articles`, `selectedView`, `selectedArticle`,
`starredCount`); components subscribe via `useStore`. `selectedView`: `{ type: 'all' | 'today' |
'starred' | 'feed', feed? }`. Star uses optimistic updates — mutate local state immediately,
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
- Outbound content/favicon fetches pass through an SSRF guard (`internal/ssrf`).
- Auth: when `AUTH_USER`/`AUTH_PASS` are set, every `/api/*` request on the public router requires
  a valid session cookie (no localhost bypass — gated by socket, not IP). Login is rate-limited.

**SQLite tables:**
- `feeds(id, name, url, last_fetched_at)`
- `article_states(article_id, feed_id, feed_name, feed_url, title, link, pub_date, pub_ts, summary, content, author, audio_url, audio_duration, is_starred, updated_at, content_updated_at)` — durable record of every fetched article
- `settings(key, value)` — e.g. `rsshub_base_url`
- `sessions(token, created_at)` — 30-day TTL
- `favicon_cache(domain, image, content_type, fetched_at)` — 30-day positive / 1-day negative TTL

**API:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/feeds` | list feeds |
| POST | `/api/feeds` | add feed |
| POST | `/api/feeds/import-opml` | bulk import from OPML |
| PATCH | `/api/feeds/:id` | rename feed |
| DELETE | `/api/feeds/:id` | remove feed + purge its non-starred articles |
| GET | `/api/feeds/:id/articles` | articles for one feed, up to 500 |
| GET | `/api/all-articles` | merged + sorted, up to 500; `?mode=latest\|digest` |
| GET | `/api/today` | today's articles, same `?mode=` toggle |
| GET | `/api/starred` | starred articles |
| GET | `/api/podcasts` | episodes with a non-empty `audio_url` |
| GET | `/api/starred/count` | badge count |
| POST | `/api/articles/star` | upsert `is_starred` |
| GET | `/api/articles/:id/content` | cached full content |
| GET | `/api/fetch-content?url=` | Readability extraction |
| GET | `/api/favicon?domain=` | cached feed favicon (BLOB) |
| GET\|POST | `/api/current-article` | in-memory "currently open" article (for MCP) |
| GET\|PATCH | `/api/settings` | read/update settings |
| POST | `/api/login` `/api/logout` | session auth |
| GET | `/api/auth-check` | whether the request is authed |

### MCP server (`internal/mcp`)

Mounted at `POST /mcp` on `NewLocalRouter` only (loopback, no auth by design). 13 tools, each a
thin self-call into `http://127.0.0.1:LOCAL_API_PORT/api/...` (`internal/mcp/client.go`) rather
than duplicating `internal/httpapi`'s handler logic: `list_feeds`, `add_feed`, `rename_feed`,
`delete_feed`, `import_opml`, `get_all_articles`, `get_today_articles`, `get_starred_articles`,
`get_feed_articles`, `get_starred_count`, `toggle_star`, `get_current_article`,
`fetch_article_content`.
