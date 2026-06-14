# CLAUDE.md

## Commands

```bash
npm run dev              # server (3002) + client (3000) in parallel
npm run server / client  # individual processes

npm install && cd server && npm install && cd ../client && npm install

# Tests
cd server && npm test           # typecheck + node:test suites
cd server && npm run test:coverage  # node:test with V8 coverage report (excludes *.test.ts, vendor/)
cd client && npm test           # vitest suites (jsdom)
cd client && npm run test:coverage  # vitest with V8 coverage report (text + html, excludes tests/types/entry)

# Production deploy
./deploy.sh              # install deps, build frontend, restart backend service

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

Single-user macOS app exposed publicly via Cloudflare Tunnel at `https://rss.royl.uk`. Session-cookie auth (`AUTH_USER` / `AUTH_PASS` env vars) gates public access. Prefer simple solutions — SQLite, in-memory cache, local files.

- Backend: launchd `com.rss-reader.app` → `~/Deploy/rss-reader/server/index.ts` on port 3002 (run via `node`'s native TS type-stripping; requires node ≥ 24 — `util.styleText` used by the vendored slog logger)
- Frontend: Vite build → `~/Deploy/rss-reader/client/dist/`, static files via Express
- Cloudflare Tunnel: `cloudflared` routes `rss.royl.uk` → `localhost:3002`
- Auth: `AUTH_USER` / `AUTH_PASS` in `server/.env` (gitignored, loaded by `load-env.ts` before `app.ts`; rsynced to deploy by `deploy.sh`). Empty/unset → auth disabled. `app.set('trust proxy', 'loopback')` is required so `req.ip` reflects the real client via cloudflared's `X-Forwarded-For` — without it every tunnel request looks like localhost and bypasses auth
- Ports: networth.local → 3001, rss.royl.uk → 3002, dev client → 3000

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
  app.ts            Express app + all API routes
  db.ts             SQLite setup, schema, migrations, seed data
  auth.ts           session login/logout + per-request gate
  articles.ts       id/enrich/dedup helpers + article_states upserts
  cache.ts          feed_cache read-through + startup warming
  favicon.ts        favicon_cache read-through (fetches from Google s2, stores BLOB)
  poller.ts         background feed polling (also kicks off the maintenance pass)
  maintenance.ts    orphan cleanup + DB size-cap enforcement (oldest non-starred deleted, then VACUUM)
  logger.ts         shared slog logger instance (NDJSON → logs/app.log)
  vendor/slog.ts    vendored zero-dep structured logger (requires node ≥ 24)
  parse-url.ts      rss-parser wrapper + feed types
  mcp.ts            MCP server (Streamable HTTP) mounted at POST /mcp
  types.ts          shared interfaces
  *.test.ts         node:test suites (import app from app.ts)
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

### Server (`server/`)

- Split into focused modules (see tree above); `app.ts` owns the Express app and routes, `index.ts` is the thin entrypoint. Tests import `app`, `db`, and helpers (`makeId`, `persistItems`) from `articles.ts`.
- TypeScript, run directly by Node ≥ 22.18 via native type-stripping — no build step. ESM (`import`/`export`); `"type": "module"` in `server/package.json`. `npm run typecheck` validates types (Node does not).
- `better-sqlite3` (synchronous, WAL mode)
- RSS fetched via `rss-parser` through `refreshFeed` (`cache.ts`): fetch upstream → write the read-through `feed_cache` (5 min TTL, **list metadata only — bodies stripped**) → `persistItems` all items into `article_states`. Both writes run in one transaction. Every fetch path routes through it — on-demand reads (`getCachedFeed` cold-miss + stale background refresh), startup warming, and the background poller (`poller.ts`, every 15 min). `INSERT OR IGNORE`, so re-persists never clobber existing rows or the starred flag. Article bodies live only in `article_states.content`; `lookupContent` reads from there (no feed_cache fallback), and `/api/search` is a single `article_states` `LIKE` query (no live-cache scan)
- Maintenance (`maintenance.ts`): runs at poller startup + every 24h. `cleanupOrphans()` deletes non-starred rows whose feed is gone (starred orphans kept). `enforceSizeCap()` caps the logical DB size at `DB_MAX_SIZE_MB` (default 2GB) — when over, deletes the oldest non-starred articles (publish time parsed from RFC-822 `pub_date`, falling back to `updated_at`) down to 90% of the cap, then `VACUUM`s. Starred articles are never deleted
- Logging: shared `logger` (`logger.ts`, vendored slog in `vendor/slog.ts`) writes NDJSON to `logs/app.log` (size rotation + gzip + retention) and pretty colorized output to a dev TTY. Use `logger.info|warn|error(...)` with a fields object; pass an Error as the `err` field to auto-serialize its stack/cause. Disabled under `TEST_DB`. Tune via `LOG_LEVEL` / `LOG_DIR`
- Article IDs: `md5(link || title+pubDate).slice(0,12)`
- `enrich()` joins live RSS items with persisted `article_states` rows
- Auth (`auth.ts`): when `AUTH_USER`/`AUTH_PASS` are set, non-localhost `/api/*` requests require a valid `session` cookie; disabled otherwise. `isLocalhost()` (exported) keys off `req.ip`, which is only trustworthy because of `trust proxy = loopback` (see Deployment). The login route is rate-limited (`express-rate-limit`)

**SQLite tables:**
- `feeds(id, name, url)`
- `article_states(article_id, feed_id, feed_name, title, link, pub_date, summary, content, author, audio_url, audio_duration, is_starred, updated_at)` — durable record of every fetched article (caches content so starred articles survive feed removal). `audio_*` added via migration for podcasts; `is_read` dropped via migration when the read/unread feature was removed
- `settings(key, value)` — e.g. `rsshub_base_url`
- `feed_cache(feed_id, feed_name, items_json, fetched_at)` — read-through RSS cache (5 min TTL); `items_json` holds list metadata only (article bodies stripped — they live in `article_states.content`)
- `sessions(token, created_at)` — auth session tokens (30-day TTL)
- `favicon_cache(domain, image, content_type, fetched_at)` — feed favicon BLOBs (positive 30-day TTL, negative 1-day; NULL `image` = upstream fetch failed)

**API:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/feeds` | list feeds |
| POST | `/api/feeds` | add feed (optional `name`, else feed title) |
| POST | `/api/feeds/import-opml` | bulk import from OPML, skips dupes |
| PATCH | `/api/feeds/:id` | rename feed |
| DELETE | `/api/feeds/:id` | remove feed |
| GET | `/api/feeds/:id/articles` | cached fetch + persisted history, up to 50 |
| GET | `/api/all-articles` | 5 items/feed, merged + sorted |
| GET | `/api/today` | all-articles filtered to today |
| GET | `/api/starred` | starred articles |
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

Mounted into the same Express app via the MCP **Streamable HTTP** transport at `POST /mcp` (stateless — fresh server + transport per request; `GET`/`DELETE` return 405). Registered in `app.ts` before the SPA `*` fallback. **Localhost-only**: non-local requests (i.e. via the tunnel) get `404` — MCP clients connect over loopback, so there is no public MCP surface. Exposes 13 tools (feed CRUD, OPML import, article lists, star, current article, full-content fetch) that call the API above over loopback (`http://localhost:3002`). Configure clients with `{ "type": "http", "url": "http://localhost:3002/mcp" }`.
