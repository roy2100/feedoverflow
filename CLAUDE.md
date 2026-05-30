# CLAUDE.md

## Commands

```bash
npm run dev              # server (3002) + client (3000) in parallel
npm run server / client  # individual processes

npm install && cd server && npm install && cd ../client && npm install

./deploy.sh              # build frontend, reload Caddy, restart backend

launchctl start|stop rss-reader.backend
launchctl kickstart -k "gui/$(id -u)/rss-reader.backend"  # force restart
tail -f /tmp/rss-reader-backend.log
```

## Deployment

Single-user local macOS app at `http://rss.local` (not internet-facing). Prefer simple solutions — SQLite, in-memory cache, local files. No auth, multi-tenancy, or rate limiting needed.

- Backend: launchd `rss-reader.backend` → `server/index.js` on port 3002
- Frontend: Vite build → `client/dist/`, static files via Caddy
- Caddy: `/api/*` → `localhost:3002`, SPA fallback otherwise; Caddyfile at `/Users/lielienan/Project/networth/Caddyfile`
- Ports: networth.local → 3001, rss.local → 3002, dev client → 3000

## Architecture

Three-panel RSS reader: **sidebar → article list → reader pane**.

```
root/               concurrently orchestrator
server/
  index.js          all API routes + SQLite setup (CommonJS, port 3002)
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

### Server (`server/index.js`)

- `better-sqlite3` (synchronous, WAL mode)
- Live RSS fetch on every request via `rss-parser` — no content cache
- Article IDs: `md5(link || title+pubDate).slice(0,12)`
- `enrich()` joins live RSS items with persisted `article_states` rows

**SQLite tables:**
- `feeds(id, name, url, category)`
- `article_states(article_id, feed_id, feed_name, title, link, pub_date, summary, content, author, is_read, is_starred, updated_at)` — caches content so starred articles survive feed removal

**API:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/feeds` | list feeds |
| POST | `/api/feeds` | add feed |
| DELETE | `/api/feeds/:id` | remove feed |
| GET | `/api/feeds/:id/articles` | live fetch, up to 50 items |
| GET | `/api/all-articles` | 5 items/feed, merged + sorted |
| GET | `/api/today` | all-articles filtered to today |
| GET | `/api/starred` | starred articles |
| GET | `/api/starred/count` | badge count |
| POST | `/api/articles/read` | upsert `is_read=1` |
| POST | `/api/articles/star` | upsert `is_starred` |
