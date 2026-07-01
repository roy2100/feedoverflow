# CLAUDE.md

## Commands

```bash
npm run dev              # server (3002) + client (3000) in parallel
npm run server / client  # individual processes

npm install && cd server && npm install && cd ../client && npm install

# Tests
cd server && npm test           # typecheck + offline node:test suites (*.test.ts)
cd server && npm run test:integration  # live-network suites (*.itest.ts — real feeds: coindesk, sspai, reddit)
cd server && npm run test:coverage  # node:test with V8 coverage report (excludes *.test.ts, vendor/)
cd client && npm test           # vitest suites (jsdom)
cd client && npm run test:coverage  # vitest with V8 coverage report (text + html, excludes tests/types/entry)

# Production deploy
./scripts/deploy-mac.sh  # install deps, build frontend, restart backend service

# Service management
launchctl start com.rss-reader.app
launchctl stop com.rss-reader.app
launchctl kickstart -k "gui/$(id -u)/com.rss-reader.app"   # force restart
tail -f ~/Deploy/rss-reader/logs/app.log      # structured NDJSON (slog); server.log holds raw stderr

# Lint & format (oxc — run from repo root, covers client + server)
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

## Deployment

Single-user macOS app exposed publicly at `https://rss.royl.uk:8443` via a **rathole** reverse tunnel to an **Aliyun VPS** that terminates TLS with **Caddy** (Let's Encrypt, DNS-01). The app still runs on the Mac; the VPS only fronts it. Session-cookie auth (`AUTH_USER` / `AUTH_PASS` env vars) gates public access. Prefer simple solutions — SQLite, in-memory cache, local files. Full setup/runbook: `docs/rathole-vps-tunnel.md`.

- Backend: launchd `com.rss-reader.app` → `~/Deploy/rss-reader/server/index.ts` on port 3002 (run via `node`'s native TS type-stripping; requires node ≥ 24 — `util.styleText` used by the vendored slog logger)
- Frontend: Vite build → `~/Deploy/rss-reader/client/dist/`, static files via Express
- Public path: browser → Caddy `:8443` (Aliyun VPS, TLS) → rathole server (VPS `:2333`, noise) → tunnel → rathole client (Mac, launchd `com.rss-reader.rathole`) → `localhost:3002`. Cloudflare is **DNS-only** (grey-cloud A record → VPS IP); the old Cloudflare Tunnel / `cloudflared` is retired. `:8443` is non-standard on purpose — avoids Aliyun mainland ICP filing (备案) for ports 80/443
- Auth: `AUTH_USER` / `AUTH_PASS` in `server/.env` (gitignored, loaded by `load-env.ts` before `app.ts`; rsynced to deploy by `scripts/deploy-mac.sh`). Empty/unset → auth disabled. `app.set('trust proxy', 'loopback')` is required so `req.ip`/`req.secure` reflect the real client: Caddy sets `X-Forwarded-Proto`/`X-Forwarded-For`, which travel through the rathole raw-TCP tunnel; the immediate peer at the app is the loopback rathole client — needed for the `Secure` cookie flag and the MCP localhost-only block (the auth gate itself no longer keys off IP)
- Ports: networth.local → 3001, rss.royl.uk:8443 (public) → VPS → tunnel → 3002, dev client → 3000, **127.0.0.1:4002 → loopback-only no-auth API + MCP** (`LOCAL_API_PORT`, never tunneled)

## Architecture

Three-panel RSS reader: **sidebar → article list → reader pane**.

One of the app's purposes is to **durably persist every fetched article** (not just starred
ones) into `article_states` for offline statistics/research. That is why *every* fetch path —
on-demand reads, background refresh, startup warming, and the poller — persists through one
shared chain (`refreshFeed` in `cache.ts` → `persistItems` in `articles.ts`), there is no
per-feed item cap on persistence, and the DB size cap defaults to 2GB. There is no read/unread
feature — articles only carry a starred flag.

```
root/               concurrently orchestrator
server/             (ESM + TS, run natively by Node, port 3002)
  index.ts          entrypoint — loads .env, sets process.title, imports app, listens, then starts background services (cache warming, poller, maintenance) only after a successful bind
  load-env.ts       loads server/.env (if present) — imported before app.ts
  app.ts            Express app assembly — middleware, auth, mounts routes/, MCP, SPA fallback (no handlers)
  routes/           per-domain express.Router() modules — feeds, settings, content, articles, search (full /api/... paths)
  db.ts             SQLite setup, schema, migrations, seed data
  auth.ts           session login/logout + per-request gate
  articles.ts       id/enrich/dedup helpers + article_states upserts
  cache.ts          refreshFeed fetch chain + ensureFresh (TTL via feeds.last_fetched_at) + startup warming
  favicon.ts        favicon_cache read-through (fetches from Google s2, stores BLOB)
  poller.ts         background feed polling (also kicks off the maintenance pass)
  maintenance.ts    orphan cleanup + DB size-cap enforcement (oldest non-starred deleted, then VACUUM)
  logger.ts         shared slog logger instance (NDJSON → logs/app.log)
  vendor/slog.ts    vendored zero-dep structured logger (requires node ≥ 24)
  parse-url.ts      rss-parser wrapper + feed types
  mcp.ts            MCP server (Streamable HTTP) mounted at POST /mcp — on the loopback-only localApp, not the public port
  types.ts          shared interfaces
  test/             node:test suites (*.test.ts offline, *.itest.ts live-network); import app/db/helpers from ../
  tsconfig.json     typecheck config (tsc --noEmit; node strips types, does not check)
  rss.db            SQLite database (gitignored)
client/             Vite + React + TypeScript (port 3000)
  src/App.tsx       top-level layout/auth/audio owner
  src/store.ts      zustand store — feeds/articles/views + all fetch logic
  src/types.ts      shared client types (Feed, Article, View, AudioCtxValue) — mirrors server/types.ts
  src/components/    *.tsx — FeedSidebar, ArticleList, ArticleReader, AddFeedModal, ManageFeedsModal, SettingsModal, PodcastPlayer, LoginForm
  src/pages/         *.tsx — mobile single-pane wrappers (FeedsPage, ListPage, ReaderPage)
  src/index.css     CSS variables (--bg, --accent, etc.)
  tsconfig.json     single strict config covering src/ (type gate only, noEmit)
  vite.config.js    stays plain JS (runs in Node, not part of the src/ type gate)
```

TypeScript, type-stripped by Vite/Vitest (no separate build step for types). `npm run typecheck`
(`tsc --noEmit`, in `client/`) is the type gate — Vite does not type-check. `strict: true`, matching the server.

**Data flow:** the `store.ts` zustand store owns app state (`feeds`, `articles`, `selectedView`, `selectedArticle`, `starredCount`) and exposes the action creators; components subscribe via `useStore`. Audio-player wiring lives in `App.tsx` and is shared through `AudioContext`. `selectedView` shape: `{ type: 'all' | 'today' | 'starred' | 'feed', feed? }`. Read/star use optimistic updates — mutate local state immediately, fire-and-forget POST to sync.

**Vite proxy:** `/api/*` → `http://localhost:3002`, so client code never hardcodes a port.

**Styling:** CSS variables in `index.css`, inline `style={{}}` in components, icons from `lucide-react`.

**UI signal-to-noise:** prioritize signal-to-noise ratio in everything the UI shows. Don't repeat
information the current context already makes obvious (e.g. hide the per-row feed name when a single
feed is selected — the header already names it), keep labels in one consistent language, and drop
stale or redundant chrome. Every pixel should carry information the user doesn't already have.

### Server (`server/`)

- Split into focused modules (see tree above); `app.ts` is assembly only (middleware → `registerAuth` → mount the `routes/` routers via `mountRouters` → SPA `*` fallback), with the API handlers living in per-domain `express.Router()` modules under `routes/`. `index.ts` is the thin entrypoint. Tests import `app`, `localApp`, `db`, and helpers (`makeId`, `persistItems`) from `articles.ts`.
  - **Two listeners share the same routers.** `app.ts` exports both the public `app` (all interfaces, auth-gated, static + SPA) and `localApp` (bound by `index.ts` to `127.0.0.1:LOCAL_API_PORT`, **no auth**, no SPA). `mountRouters()` mounts the same router instances on both. `registerMcp` runs **only on `localApp`** — there is no public MCP surface. "Whether auth applies" is decided by which socket a request arrived on, not by a spoofable header.
  - **Route registration order is load-bearing**: on the public `app`, routers mount after `registerAuth(app)` (so the `/api` auth gate covers them) and before the `*` SPA fallback. Each router carries full `/api/...` paths and is mounted bare (`app.use(router)`); `:id` paths for one domain (e.g. feeds) stay in one router to keep Express matching intact.
- TypeScript, run directly by Node ≥ 22.18 via native type-stripping — no build step. ESM (`import`/`export`); `"type": "module"` in `server/package.json`. `npm run typecheck` validates types (Node does not).
- `better-sqlite3` (synchronous, WAL mode)
- RSS fetched via `rss-parser` through `refreshFeed` (`cache.ts`): fetch upstream → `persistItems` all items into `article_states` → stamp `feeds.last_fetched_at` (epoch ms). Both writes run in one transaction. There is **no separate items cache** — the list endpoints read straight from `article_states`; `feeds.last_fetched_at` is only a 5-min TTL freshness signal. `ensureFresh(feed)` decides per request: fresh → serve as-is; stale-but-fetched-before → background refresh; brand-new feed with no rows → await one fetch. Every fetch path routes through `refreshFeed` — on-demand reads (`ensureFresh`), startup warming, and the background poller (`poller.ts`, every 15 min). `persistItems` **upserts** on the `article_id` PK: a new item inserts, a re-fetched item refreshes its content fields (title/summary/content/author/pub_date) so the local row tracks upstream edits, guarded by a `WHERE …<>excluded…` clause so unchanged rows aren't rewritten (no spurious `updated_at` bumps). `is_starred` is never touched, so the user's flag survives; `feed_id`/`feed_name` are set only on insert (a live feed never re-homes an article, and deleting a feed purges its rows — see `DELETE /api/feeds/:id`). When the update fires, content genuinely changed, so `content_updated_at` (epoch ms) is stamped — the reader shows an "更新于" time only when it is set. On-demand Readability full-text (`/api/fetch-content`) is **not** persisted, so the feed stays the sole `content` source. Article bodies live only in `article_states.content`; `lookupContent` reads from there, and `/api/search` is a single `article_states` `LIKE` query. Each row also carries `pub_ts` (sortable publish epoch-ms, parsed from `pub_date`) so list reads use `ORDER BY pub_ts DESC`. `article_id` is the global PRIMARY KEY (no cross-feed dupes), so the merged `latest` lists are a single global `ORDER BY pub_ts DESC LIMIT 500` served by a standalone `(pub_ts)` index; the `digest` lists fan out per-feed (each scan served by the `(feed_id, pub_ts)` index) and merge-sort in JS
- Maintenance (`maintenance.ts`): runs at poller startup + every 24h. `cleanupOrphans()` deletes non-starred rows whose feed is gone (starred orphans kept). `enforceSizeCap()` caps the logical DB size at `DB_MAX_SIZE_MB` (default 2GB) — when over, deletes the oldest non-starred articles (publish time parsed from RFC-822 `pub_date`, falling back to `updated_at`) down to 90% of the cap, then `VACUUM`s. Starred articles are never deleted
- Logging: shared `logger` (`logger.ts`, vendored slog in `vendor/slog.ts`) writes NDJSON to `logs/app.log` (size rotation + gzip + retention) and pretty colorized output to a dev TTY. Use `logger.info|warn|error(...)` with a fields object; pass an Error as the `err` field to auto-serialize its stack/cause. Disabled under `TEST_DB`. Tune via `LOG_LEVEL` / `LOG_DIR`
- Article IDs: `md5(link || title+pubDate).slice(0,12)`
- `enrich()` joins live RSS items with persisted `article_states` rows
- Auth (`auth.ts`): when `AUTH_USER`/`AUTH_PASS` are set, **every** `/api/*` request on the public `app` requires a valid `session` cookie — no localhost bypass, local and remote are gated identically; disabled otherwise (`/api/login` `/api/logout` `/api/auth-check` are registered before the gate and stay reachable). The auth gate is **not** installed on `localApp`, so the loopback-only port serves the API unauthenticated by design. `isLocalhost()` is still exported but only the MCP transport uses it now (redundant defense-in-depth, since `localApp` is already loopback-bound). The login route is rate-limited (`express-rate-limit`)

**SQLite tables:**
- `feeds(id, name, url, last_fetched_at)` — `last_fetched_at` (epoch ms) is the per-feed refresh freshness stamp
- `article_states(article_id, feed_id, feed_name, title, link, pub_date, pub_ts, summary, content, author, audio_url, audio_duration, is_starred, updated_at, content_updated_at)` — durable record of every fetched article (caches content so starred articles survive feed removal). `audio_*`, `pub_ts` (sortable publish epoch-ms, indexed with `feed_id`), and `content_updated_at` (epoch ms of the last genuine upstream content edit; NULL until first edited) added via migration; `is_read` dropped via migration when the read/unread feature was removed
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

### MCP server (`server/mcp.ts`)

Mounted via the MCP **Streamable HTTP** transport at `POST /mcp` (stateless — fresh server + transport per request; `GET`/`DELETE` return 405), **only on the loopback-only `localApp`** (`registerMcp(localApp)` in `app.ts`), never on the public port. Because that listener is bound to `127.0.0.1:LOCAL_API_PORT`, there is no public MCP surface — a request via the tunnel can never reach it (the `isLocalhost` check remains as redundant defense-in-depth). Exposes 13 tools (feed CRUD, OPML import, article lists, star, current article, full-content fetch) that call the API over loopback at `http://127.0.0.1:${LOCAL_API_PORT}` — the **no-auth** listener, so the internal calls pass even when `AUTH_USER`/`AUTH_PASS` are set (this is what fixed MCP-under-auth). Configure clients with `{ "type": "http", "url": "http://localhost:4002/mcp" }` (or whatever `LOCAL_API_PORT` is set to).
