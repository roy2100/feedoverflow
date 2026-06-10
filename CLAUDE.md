# CLAUDE.md

## Commands

```bash
npm run dev              # server (3002) + client (3000) in parallel
npm run server / client  # individual processes

npm install && cd server && npm install && cd ../client && npm install

# Production deploy
./deploy.sh              # install deps, build frontend, restart backend service

# Service management
launchctl start com.rss-reader.app
launchctl stop com.rss-reader.app
launchctl kickstart -k "gui/$(id -u)/com.rss-reader.app"   # force restart
tail -f ~/Deploy/rss-reader/logs/server.log
```

## Deployment

Single-user macOS app exposed publicly via Cloudflare Tunnel at `https://rss.royl.uk`. Session-cookie auth (`AUTH_USER` / `AUTH_PASS` env vars) gates public access. Prefer simple solutions — SQLite, in-memory cache, local files.

- Backend: launchd `com.rss-reader.app` → `~/Deploy/rss-reader/server/index.ts` on port 3002 (run via `node`'s native TS type-stripping; requires node ≥ 22.18)
- Frontend: Vite build → `~/Deploy/rss-reader/client/dist/`, static files via Express
- Cloudflare Tunnel: `cloudflared` routes `rss.royl.uk` → `localhost:3002`
- Auth: `AUTH_USER` / `AUTH_PASS` in `server/.env` (gitignored, loaded by `load-env.ts` before `app.ts`; rsynced to deploy by `deploy.sh`). Empty/unset → auth disabled. `app.set('trust proxy', 'loopback')` is required so `req.ip` reflects the real client via cloudflared's `X-Forwarded-For` — without it every tunnel request looks like localhost and bypasses auth
- Ports: networth.local → 3001, rss.royl.uk → 3002, dev client → 3000

## Architecture

Three-panel RSS reader: **sidebar → article list → reader pane**.

```
root/               concurrently orchestrator
server/             (ESM + TS, run natively by Node, port 3002)
  index.ts          entrypoint — loads .env, sets process.title, imports app, listens
  load-env.ts       loads server/.env (if present) — imported before app.ts
  app.ts            Express app + all API routes
  db.ts             SQLite setup, schema, migrations, seed data
  auth.ts           session login/logout + per-request gate
  articles.ts       id/enrich/dedup helpers + article_states upserts
  cache.ts          feed_cache read-through + startup warming
  poller.ts         background feed polling
  parse-url.ts      rss-parser wrapper + feed types
  mcp.ts            MCP server (Streamable HTTP) mounted at POST /mcp
  types.ts          shared interfaces
  *.test.ts         node:test suites (import app from app.ts)
  tsconfig.json     typecheck config (tsc --noEmit; node strips types, does not check)
  rss.db            SQLite database (gitignored)
client/             Vite + React (port 3000)
  src/App.jsx       central state owner — all fetch logic lives here
  src/components/
    FeedSidebar     left panel: smart feeds + subscribed feeds
    ArticleList     middle panel: article rows with star/unread dot
    ArticleReader   right panel: full article content
    AddFeedModal    portal modal for adding a new feed
  src/index.css     CSS variables (--bg, --accent, etc.)
```

**Data flow:** `App.jsx` owns all state (`feeds`, `articles`, `selectedView`, `selectedArticle`, `starredCount`); props-only, no context/store. `selectedView` shape: `{ type: 'all' | 'today' | 'starred' | 'feed', feed? }`. Read/star use optimistic updates — mutate local state immediately, fire-and-forget POST to sync.

**Vite proxy:** `/api/*` → `http://localhost:3002`, so client code never hardcodes a port.

**Styling:** CSS variables in `index.css`, inline `style={{}}` in components, icons from `lucide-react`.

### Server (`server/`)

- Split into focused modules (see tree above); `app.ts` owns the Express app and routes, `index.ts` is the thin entrypoint. Tests import `app`, `db`, `makeId`, `persistPolled` re-exported from `app.ts`.
- TypeScript, run directly by Node ≥ 22.18 via native type-stripping — no build step. ESM (`import`/`export`); `"type": "module"` in `server/package.json`. `npm run typecheck` validates types (Node does not).
- `better-sqlite3` (synchronous, WAL mode)
- RSS fetched via `rss-parser` through a read-through `feed_cache` (5 min TTL, `cache.ts`); a background poller (`poller.ts`) refreshes feeds and persists new items into `article_states`
- Article IDs: `md5(link || title+pubDate).slice(0,12)`
- `enrich()` joins live RSS items with persisted `article_states` rows
- Auth (`auth.ts`): when `AUTH_USER`/`AUTH_PASS` are set, non-localhost `/api/*` requests require a valid `session` cookie; disabled otherwise. `isLocalhost()` (exported) keys off `req.ip`, which is only trustworthy because of `trust proxy = loopback` (see Deployment). The login route is rate-limited (`express-rate-limit`)

**SQLite tables:**
- `feeds(id, name, url)`
- `article_states(article_id, feed_id, feed_name, title, link, pub_date, summary, content, author, audio_url, audio_duration, is_read, is_starred, updated_at)` — caches content so starred articles survive feed removal (`audio_*` added via migration for podcasts)
- `settings(key, value)` — e.g. `rsshub_base_url`
- `feed_cache(feed_id, feed_name, items_json, fetched_at)` — read-through RSS cache (5 min TTL)
- `sessions(token, created_at)` — auth session tokens (30-day TTL)

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
| GET | `/api/unread-counts` | per-feed unread counts |
| POST | `/api/articles/read` | upsert `is_read=1` |
| POST | `/api/articles/star` | upsert `is_starred` |
| GET | `/api/articles/:id/content` | cached full content for an article |
| GET | `/api/fetch-content?url=` | extract readable content via Readability |
| GET\|POST | `/api/current-article` | in-memory "currently open" article (for MCP) |
| GET\|PATCH | `/api/settings` | read/update settings (e.g. `rsshub_base_url`) |
| POST | `/api/login` `/api/logout` | session auth (when enabled) |
| GET | `/api/auth-check` | whether the request is authed |

### MCP server (`server/mcp.ts`)

Mounted into the same Express app via the MCP **Streamable HTTP** transport at `POST /mcp` (stateless — fresh server + transport per request; `GET`/`DELETE` return 405). Registered in `app.ts` before the SPA `*` fallback. **Localhost-only**: non-local requests (i.e. via the tunnel) get `404` — MCP clients connect over loopback, so there is no public MCP surface. Exposes 14 tools (feed CRUD, OPML import, article lists, read/star, current article, full-content fetch) that call the API above over loopback (`http://localhost:3002`). Configure clients with `{ "type": "http", "url": "http://localhost:3002/mcp" }`.
