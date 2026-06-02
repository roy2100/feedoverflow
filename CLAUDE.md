# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev              # server (3002) + client (3000) in parallel
npm run server           # server only (port 3002)
npm run client           # client only (port 3000)

# Install all dependencies
npm install && cd server && npm install && cd ../client && npm install

# Production deploy
./deploy.sh              # install deps, build frontend, restart backend service

# Service management
launchctl start com.rss-reader.app
launchctl stop com.rss-reader.app
launchctl kickstart -k "gui/$(id -u)/com.rss-reader.app"   # force restart
tail -f ~/Deploy/rss-reader/logs/server.log
```

There are no test or lint scripts configured.

## Deployment context

Single-user app running locally on macOS, exposed publicly via Cloudflare Tunnel at `https://rss.royl.uk`. Basic Auth (`AUTH_USER` / `AUTH_PASS` env vars) gates public access. Prefer simple, lightweight solutions (in-memory cache, SQLite, local files) over over-engineered ones.

**Production stack:**
- Backend: launchd service (`com.rss-reader.app`) running `~/Deploy/rss-reader/server/index.js` on port 3002, auto-starts on boot
- Frontend: Vite build → `~/Deploy/rss-reader/client/dist/`, served as static files by Express
- Cloudflare Tunnel: `cloudflared` routes `rss.royl.uk` → `localhost:3002`
- Auth: set `AUTH_USER` and `AUTH_PASS` in `~/Library/LaunchAgents/com.rss-reader.app.plist`

**Port allocation (no conflicts with networth.local):**
- `networth.local` backend → 3001
- `rss.royl.uk` backend → 3002
- Dev client → 3000

## Architecture

Three-panel RSS reader: **sidebar → article list → reader pane**.

```
root/               concurrently orchestrator
server/             Express (CommonJS, port 3002)
  index.js          all API routes + SQLite setup in one file
  rss.db            SQLite database (gitignored)
client/             Vite + React (port 3000)
  src/App.jsx       central state owner — all fetch logic lives here
  src/components/
    FeedSidebar     left panel: smart feeds + subscribed feeds
    ArticleList     middle panel: article rows with star/unread dot
    ArticleReader   right panel: full article content
    AddFeedModal    portal modal for adding a new feed
  src/index.css     CSS variables (--bg, --accent, etc.) + global keyframes
```

### Data flow

`App.jsx` owns all state (`feeds`, `articles`, `selectedView`, `selectedArticle`, `starredCount`). Components receive data and callbacks via props — no context or external store.

`selectedView` has shape `{ type: 'all' | 'today' | 'starred' | 'feed', feed? }`. Changing it triggers `loadArticles`, which picks the right API endpoint.

Read/star changes use **optimistic updates**: local state is mutated immediately, then a fire-and-forget `POST` syncs to the server.

### Server

`server/index.js` is a single-file Express server (CommonJS). It:
- Opens `rss.db` with `better-sqlite3` (synchronous, WAL mode)
- Seeds 4 default feeds on first run
- Fetches live RSS on every request via `rss-parser` — no feed content cache
- Assigns stable article IDs as `md5(link || title+pubDate).slice(0,12)`
- The `enrich()` function joins live RSS items with persisted `article_states` rows

**SQLite tables:**
- `feeds(id, name, url, category)` — user's subscription list
- `article_states(article_id, feed_id, feed_name, title, link, pub_date, summary, content, author, is_read, is_starred, updated_at)` — stores read/starred state; also caches article content so starred articles survive feed removal

**API surface:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/feeds` | list feeds |
| POST | `/api/feeds` | add feed |
| DELETE | `/api/feeds/:id` | remove feed |
| GET | `/api/feeds/:id/articles` | live fetch, up to 50 items |
| GET | `/api/all-articles` | 5 items per feed, merged + sorted |
| GET | `/api/today` | all-articles filtered to today |
| GET | `/api/starred` | articles from `article_states` where `is_starred=1` |
| GET | `/api/starred/count` | lightweight badge count |
| POST | `/api/articles/read` | upsert `is_read=1` |
| POST | `/api/articles/star` | upsert `is_starred` |

### Client proxy

Vite proxies `/api/*` → `http://localhost:3002` in `client/vite.config.js`, so client code always uses `/api/…` with no hardcoded port.

### Styling

All colours are CSS variables defined in `index.css`. Components use inline `style={{}}` throughout — there is no CSS-modules or Tailwind setup. Icons come from `lucide-react`.
