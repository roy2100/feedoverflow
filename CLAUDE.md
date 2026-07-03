# CLAUDE.md

## Commands

```bash
npm run dev              # Go server (3002) + client (3000) in parallel
npm run server / client  # individual processes (server → `cd server-go && go run .`)

npm install && cd client && npm install   # client + root tooling deps (Go backend uses go modules)

# Tests
cd server-go && make check      # fmt-check + lint (vet + staticcheck) + offline unit tests
cd server-go && make test       # lint + offline unit tests (*_test.go)
cd server-go && make test-int   # live-network suites (build tag itest — real feeds: coindesk, sspai, reddit)
cd server-go && make cover      # go test with coverage report
cd client && npm test           # vitest suites (jsdom)
cd client && npm run test:coverage  # vitest with V8 coverage report (text + html, excludes tests/types/entry)
./scripts/burst-latency.sh      # concurrent-burst latency smoke test vs a running server (loopback :4002)
                                # ROUNDS=/BASE_URL=/FAIL_MS= env overrides; FAIL_MS gates a regression

# Production deploy (Go backend)
./scripts/deploy.sh             # build client + cgo Go binary on the Mac, sync to ~/Deploy, kickstart the installed service, health-check
./scripts/install-service.sh    # register the launchd job (write plist + bootstrap); run once on a fresh box, after deploy.sh builds the binary
./scripts/uninstall-service.sh  # stop + remove the launchd job (deployed files kept)

# Service management
launchctl start com.rss-reader.app
launchctl stop com.rss-reader.app
launchctl kickstart -k "gui/$(id -u)/com.rss-reader.app"   # force restart
tail -f ~/Deploy/rss-reader/logs/app.log      # structured NDJSON (slog); server.log holds raw stderr

# Lint & format (oxc — run from repo root; now covers the client only, the Go backend uses gofmt/staticcheck)
npm run fmt              # oxfmt: format & write in place
npm run fmt:check        # oxfmt: check only, no writes
npm run lint             # oxlint: catch-bug rules (correctness=error)
npm run lint:fix         # oxlint: auto-fix what it can
```

## Lint & Format Workflow (oxlint + oxfmt)

Formatting and linting use [oxlint](https://oxc.rs) (`.oxlintrc.json`) and [oxfmt](https://oxc.rs)
(`.oxfmtrc.json`), both run from the repo root with `npm`. oxfmt owns all style/formatting; oxlint
only runs catch-bug rules (`categories.correctness = "error"`) — never add style rules to the linter.

**After generating or modifying any code, always run:**

```bash
npm run fmt              # auto-format the changes
npm run lint:fix         # auto-fix lint issues
```

**Before committing, ensure both pass clean:**

```bash
npm run fmt:check        # must report no unformatted files
npm run lint             # must exit 0 (no correctness errors)
```

Do not silence lint errors or rewrite business logic just to make `lint` pass — if a correctness
rule flags real intent, surface it rather than auto-suppressing.

oxlint/oxfmt now cover the **client only** — the Go backend (`server-go/`) is formatted with
`gofmt` and vetted with `go vet` + `staticcheck` via its Makefile. After changing Go code, run
`cd server-go && make fmt` then `make check` (fmt-check + lint + tests) before committing.

## Deployment

Single-user macOS app exposed publicly at `https://rss.royl.uk:8443` via a **rathole** reverse tunnel to an **Aliyun VPS** that terminates TLS with **Caddy** (Let's Encrypt, DNS-01). The app still runs on the Mac; the VPS only fronts it. Session-cookie auth (`AUTH_USER` / `AUTH_PASS` env vars) gates public access. Prefer simple solutions — SQLite, in-memory cache, local files. Full setup/runbook: `docs/rathole-vps-tunnel.md`.

- Backend: launchd `com.rss-reader.app` → the compiled Go binary at `~/Deploy/rss-reader/rss-reader` on port 3002 (single cgo binary — `mattn/go-sqlite3` — built on the Mac, no runtime deps). Built + synced by `scripts/deploy.sh`; the launchd job is registered by `scripts/install-service.sh`
- Frontend: Vite build → `~/Deploy/rss-reader/client/dist/`, served as static files by the Go server (`CLIENT_DIST` env)
- Public path: browser → Caddy `:8443` (Aliyun VPS, TLS) → rathole server (VPS `:2333`, noise) → tunnel → rathole client (Mac, launchd `com.rss-reader.rathole`) → `localhost:3002`. Cloudflare is **DNS-only** (grey-cloud A record → VPS IP); the old Cloudflare Tunnel / `cloudflared` is retired. `:8443` is non-standard on purpose — avoids Aliyun mainland ICP filing (备案) for ports 80/443
- Auth: `AUTH_USER` / `AUTH_PASS` loaded from the env file pointed to by `RSS_ENV_FILE` (default `~/Deploy/rss-reader/server/.env`, gitignored; the plist sets it). Empty/unset → auth disabled. When set, **every** request on the public listener requires a valid session cookie
- Ports: networth.local → 3001, rss.royl.uk:8443 (public) → VPS → tunnel → 3002, dev client → 3000, **127.0.0.1:4002 → loopback-only no-auth API** (`LOCAL_API_PORT`, never tunneled — reserved as the future MCP host)

## Architecture

Three-panel RSS reader: **sidebar → article list → reader pane**.

One of the app's purposes is to **durably persist every fetched article** (not just starred
ones) into `article_states` for offline statistics/research. That is why *every* fetch path —
on-demand reads, background refresh, startup warming, and the poller — persists through one
shared refresh/persist chain (`internal/cache` → `internal/store` into `article_states`), there is no
per-feed item cap on persistence, and the DB size cap defaults to 2GB. There is no read/unread
feature — articles only carry a starred flag.

```
root/               concurrently orchestrator (`npm run dev`)
server-go/          Go backend (single cgo binary, port 3002 — chi router, mattn/go-sqlite3)
  main.go           entrypoint — load config, open DB, build logger, start public + loopback listeners, then background jobs (gated by RSS_DISABLE_JOBS)
  internal/config   env config (Load / LoadEnvFile via RSS_ENV_FILE; PORT, LOCAL_API_PORT, RSS_DB, AUTH_*, DB_MAX_SIZE_MB, REFRESH_CONCURRENCY, CLIENT_DIST, LOG_DIR)
  internal/httpapi  Server struct + NewPublicRouter / NewLocalRouter; per-domain handlers (feeds.go, content.go, search.go, static.go) carrying full /api/... paths
  internal/db       SQLite open (WAL), schema + migrations
  internal/auth     session login/logout + per-request gate (auth.go) + login rate-limit (ratelimit.go)
  internal/articles id/enrich/dedup helpers over article_states
  internal/store    article_states writes — persist upserts, feed writes, adopt-orphans
  internal/cache    refreshFeed fetch chain + ensureFresh (TTL via feeds.last_fetched_at) + startup warming
  internal/favicon  favicon_cache read-through (fetches from Google s2, stores BLOB)
  internal/jobs     background workers — poller, maintenance (orphan cleanup + size-cap + VACUUM), resource monitor, WAL checkpoint
  internal/feed     gofeed RSS wrapper (ParseURL) + feed types
  internal/dates    publish-date parsing (parsePubDate / pubTs)
  internal/ssrf     SSRF guard for outbound content/favicon fetches
  internal/model    shared structs
  internal/logger   slog logger + lumberjack rotation (NDJSON → logs/app.log)
  internal/httpx    JSON response helpers
  internal/crash    panic guard (Go analogue of the uncaughtException handler)
  cmd/dbinit, cmd/freezefeeds   CLI utilities
  Makefile          run/build/test/lint/cover/deploy targets; go.mod pins Go 1.26
  *_test.go         offline unit tests; *_itest.go (build tag itest) live-network suites
client/             Vite + React + TypeScript (port 3000)
  src/App.tsx       top-level layout/auth/audio owner
  src/store.ts      zustand store — feeds/articles/views + all fetch logic
  src/types.ts      shared client types (Feed, Article, View, AudioCtxValue) — mirrors the backend JSON shapes (server-go/internal/model)
  src/components/    *.tsx — FeedSidebar, ArticleList, ArticleReader, AddFeedModal, ManageFeedsModal, SettingsModal, PodcastPlayer, LoginForm
  src/pages/         *.tsx — mobile single-pane wrappers (FeedsPage, ListPage, ReaderPage)
  src/index.css     CSS variables (--bg, --accent, etc.)
  tsconfig.json     single strict config covering src/ (type gate only, noEmit)
  vite.config.js    stays plain JS (runs in Node, not part of the src/ type gate)
```

TypeScript, type-stripped by Vite/Vitest (no separate build step for types). `npm run typecheck`
(`tsc --noEmit`, in `client/`) is the type gate — Vite does not type-check. `strict: true`.

**Data flow:** the `store.ts` zustand store owns app state (`feeds`, `articles`, `selectedView`, `selectedArticle`, `starredCount`) and exposes the action creators; components subscribe via `useStore`. Audio-player wiring lives in `App.tsx` and is shared through `AudioContext`. `selectedView` shape: `{ type: 'all' | 'today' | 'starred' | 'feed', feed? }`. Read/star use optimistic updates — mutate local state immediately, fire-and-forget POST to sync.

**Vite proxy:** `/api/*` → `http://localhost:3002`, so client code never hardcodes a port.

**Styling:** CSS variables in `index.css`, inline `style={{}}` in components, icons from `lucide-react`.

**UI signal-to-noise:** prioritize signal-to-noise ratio in everything the UI shows. Don't repeat
information the current context already makes obvious (e.g. hide the per-row feed name when a single
feed is selected — the header already names it), keep labels in one consistent language, and drop
stale or redundant chrome. Every pixel should carry information the user doesn't already have.

### Server (`server-go/`)

The Go backend is a strict 1:1 port of the original Node server (see `docs/plan-go-backend-migration.md`) — same API, same SQLite schema, same behavior, enforced by differential "oracle" tests. The Node original is preserved on the `legacy_server_node` branch. The invariants below are the ported contract; only the language/module names changed.

- Split into focused packages under `internal/` (see tree above); `main.go` is the thin entrypoint (load config → open DB → build logger → start both listeners → start jobs). `internal/httpapi` owns the `Server` struct and both router constructors, with per-domain handlers (`feeds.go`, `content.go`, `search.go`, `static.go`) carrying full `/api/...` paths on a chi router.
  - **Two listeners share the same handlers.** `srv.NewPublicRouter()` (all interfaces, auth-gated, static + SPA) and `srv.NewLocalRouter()` (bound by `main.go` to `127.0.0.1:LOCAL_API_PORT`, **no auth**, no SPA). "Whether auth applies" is decided by which socket a request arrived on, not by a spoofable header. **MCP is not ported** — the loopback listener currently has no MCP consumer; it is kept and reserved as the future Go MCP host.
  - The `/api` auth gate is chi middleware on the public router only; `/api/login` `/api/logout` `/api/auth-check` are registered outside it and stay reachable.
- Go 1.26, compiled to a single **cgo** binary (`mattn/go-sqlite3`, WAL mode) — must be built on the Mac (`CGO_ENABLED=1`). `make check` (fmt-check + `go vet` + `staticcheck` + tests) is the gate.
- RSS fetched via `gofeed` (`internal/feed`) through the refresh chain (`internal/cache`): fetch upstream → persist all items into `article_states` (`internal/store`) → stamp `feeds.last_fetched_at` (epoch ms). Both writes run in one transaction. There is **no separate items cache** — the list endpoints read straight from `article_states`; `feeds.last_fetched_at` is only a 5-min TTL freshness signal. `ensureFresh` decides per request: fresh → serve as-is; stale-but-fetched-before → background refresh; brand-new feed with no rows → await one fetch. Every fetch path routes through the same chain — on-demand reads, startup warming, and the background poller (`internal/jobs`, every 15 min). The persist step **upserts** on the `article_id` PK: a new item inserts, a re-fetched item refreshes its content fields (title/summary/content/author/pub_date) so the local row tracks upstream edits, guarded by a `WHERE …<>excluded…` clause so unchanged rows aren't rewritten (no spurious `updated_at` bumps). `is_starred` is never touched, so the user's flag survives; `feed_id`/`feed_name`/`feed_url` are set only on insert (a live feed never re-homes an article; deleting a feed purges its non-starred rows — see `DELETE /api/feeds/:id`). Kept starred rows keep their `feed_url`, so re-adding the same URL re-adopts them (adopt-orphans, the one deliberate re-home path). When the update fires, content genuinely changed, so `content_updated_at` (epoch ms) is stamped — the reader shows an "更新于" time only when it is set. On-demand Readability full-text (`/api/fetch-content`, via `go-readability`) is **not** persisted, so the feed stays the sole `content` source. Article bodies live only in `article_states.content`; the content lookup reads from there, and `/api/search` is a single `article_states` `LIKE` query. Each row also carries `pub_ts` (sortable publish epoch-ms, parsed from `pub_date`) so list reads use `ORDER BY pub_ts DESC`. `article_id` is the global PRIMARY KEY (no cross-feed dupes), so the merged `latest` lists are a single global `ORDER BY pub_ts DESC LIMIT 500` served by a standalone `(pub_ts)` index; the `digest` lists fan out per-feed (each scan served by the `(feed_id, pub_ts)` index) and merge-sort in Go
- Maintenance (`internal/jobs/maintenance.go`): runs at poller startup + every 24h. Orphan cleanup deletes non-starred rows whose feed is gone (starred orphans kept). The size cap bounds the logical DB size at `DB_MAX_SIZE_MB` (default 2GB) — when over, deletes the oldest non-starred articles (publish time parsed from RFC-822 `pub_date`, falling back to `updated_at`) down to 90% of the cap, then `VACUUM`s. Starred articles are never deleted
- Logging: shared slog logger (`internal/logger`) writes NDJSON to `<LogDir>/app.log` (lumberjack size rotation + gzip + retention) or stderr when `LogDir` is unset. Background workers carry a `crash.Guard` panic handler. Tune via `LOG_DIR`
- Article IDs: `md5(link || title+pubDate)` truncated to 12 chars (`internal/dates`/`internal/articles`)
- Outbound content/favicon fetches pass through an SSRF guard (`internal/ssrf`)
- Auth (`internal/auth`): when `AUTH_USER`/`AUTH_PASS` are set, **every** `/api/*` request on the public router requires a valid `session` cookie — no localhost bypass, local and remote are gated identically; disabled otherwise. The gate is **not** installed on the loopback router, so `LOCAL_API_PORT` serves the API unauthenticated by design (loopback-bound). The login route is rate-limited (`ratelimit.go`)

**SQLite tables:**
- `feeds(id, name, url, last_fetched_at)` — `last_fetched_at` (epoch ms) is the per-feed refresh freshness stamp
- `article_states(article_id, feed_id, feed_name, feed_url, title, link, pub_date, pub_ts, summary, content, author, audio_url, audio_duration, is_starred, updated_at, content_updated_at)` — durable record of every fetched article (caches content so starred articles survive feed removal). `audio_*`, `pub_ts` (sortable publish epoch-ms, indexed with `feed_id`), `content_updated_at` (epoch ms of the last genuine upstream content edit; NULL until first edited), and `feed_url` (origin feed URL, set insert-only alongside `feed_id`/`feed_name`) added via migration; `is_read` dropped via migration when the read/unread feature was removed. `feed_url` survives feed deletion so a re-added URL can re-adopt its own kept starred orphans (`adoptStarredOrphans` in `articles.ts`, called from `POST /api/feeds` + OPML import)
- `settings(key, value)` — e.g. `rsshub_base_url`
- `feeds.last_fetched_at` (epoch ms) — per-feed freshness stamp driving the 5-min refresh TTL (replaced the old `feed_cache` table, which duplicated `article_states` list metadata)
- `sessions(token, created_at)` — auth session tokens (30-day TTL)
- `favicon_cache(domain, image, content_type, fetched_at)` — feed favicon BLOBs (positive 30-day TTL, negative 1-day; NULL `image` = upstream fetch failed)

**API:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/feeds` | list feeds |
| POST | `/api/feeds` | add feed (optional `name`, else feed title) |
| POST | `/api/feeds/import-opml` | bulk import from OPML, skips dupes |
| PATCH | `/api/feeds/:id` | rename feed |
| DELETE | `/api/feeds/:id` | remove feed + purge its non-starred articles (starred kept) |
| GET | `/api/feeds/:id/articles` | cached fetch + persisted history, up to 500 |
| GET | `/api/all-articles` | merged + sorted, up to 500 (shared `LIST_LIMIT`); `?mode=latest` (default, strict global newest) or `?mode=digest` (per-feed quota so every feed is represented) |
| GET | `/api/today` | all-articles filtered to today, up to 500 (shared `LIST_LIMIT`); same `?mode=latest|digest` toggle |
| GET | `/api/starred` | starred articles |
| GET | `/api/podcasts` | recently-updated podcast episodes (articles with a non-empty `audio_url`), newest first |
| GET | `/api/starred/count` | badge count |
| POST | `/api/articles/star` | upsert `is_starred` |
| GET | `/api/articles/:id/content` | cached full content for an article |
| GET | `/api/fetch-content?url=` | extract readable content via Readability |
| GET | `/api/favicon?domain=` | cached feed favicon (BLOB); always `200` — falls back to a default placeholder SVG when unavailable |
| GET\|POST | `/api/current-article` | in-memory "currently open" article (for MCP) |
| GET\|PATCH | `/api/settings` | read/update settings (e.g. `rsshub_base_url`) |
| POST | `/api/login` `/api/logout` | session auth (when enabled) |
| GET | `/api/auth-check` | whether the request is authed |

### MCP server — not in the Go backend (pending)

> **Status:** the MCP server was **not** ported in the Go migration (explicitly out of scope —
> see `docs/plan-go-backend-migration.md`). The current Go backend serves no `/mcp` endpoint. The
> loopback-only, no-auth listener (`127.0.0.1:LOCAL_API_PORT`) is kept and **reserved as the future
> Go MCP host**, but currently has no MCP consumer. The full Node MCP implementation (Streamable
> HTTP transport, 13 tools) is preserved on the `legacy_server_node` branch.

When MCP is ported to Go, it must mount on the loopback listener only (never the public port) and
call the API over loopback at `http://127.0.0.1:${LOCAL_API_PORT}` — the no-auth listener — so
internal calls pass even when `AUTH_USER`/`AUTH_PASS` are set, matching the original design.
