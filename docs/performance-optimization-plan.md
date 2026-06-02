# Homepage Load Performance Optimization Plan

**Date:** 2026-06-01  
**Scope:** First-contentful-paint and time-to-interactive for the main RSS reader view

---

## Current Bottlenecks

### Critical Path on Startup

```
Browser loads HTML/JS/CSS
  → App mounts → init() + loadArticles('today') fire in parallel
      → init():        GET /api/feeds  +  GET /api/starred/count   (fast, SQLite only)
      → loadArticles(): GET /api/today  ← **main bottleneck**
           → server iterates all feeds via getCachedFeed()
               cold cache: awaits each feed's HTTP fetch (up to 10s timeout)
               warm cache: returns immediately
  → articles render
```

The server warms the cache on startup (`fetchAndCache` fire-and-forget on line 198), but it's a race condition — if the client request arrives before warming completes, the response blocks on live RSS fetches across all feeds.

### Backend Issues

| Issue | Location | Impact |
|-------|----------|--------|
| **N+1 SQLite queries** in `enrich()` | `server/index.js:118` | One `getState.get(id)` call per article; 50 articles × N feeds = hundreds of queries per request |
| **No response compression** | `server/index.js` | Article content (HTML) and article lists sent uncompressed |
| **No HTTP caching headers** | all API routes | Browser re-fetches on every navigation, even for static-ish data like `/api/feeds` |
| **Cache warmup is fire-and-forget** | `server/index.js:198` | No signal when all feeds are ready; first request may block on cold fetches |

### Frontend Issues

| Issue | Location | Impact |
|-------|----------|--------|
| **All modals always imported** | `App.jsx:7-11` | `AddFeedModal`, `ManageFeedsModal`, `SettingsModal`, `PodcastPlayer` bundled into main chunk even though rarely used |
| **Spinner instead of skeleton** | `ArticleList.jsx:64` | Blank/spinner while loading; skeleton would show layout immediately |
| **`unreadCount` recomputed every render** | `App.jsx:86` | `articles.filter(...)` runs on every state update, including unrelated ones |
| **PWA uses NetworkFirst for API** | `vite.config.js:47` | Forces a network round-trip before showing anything, even when fresh cache exists |
| **No client-side article cache** | `store.js` | Switching back to a previously loaded view re-fetches from scratch |

---

## Optimization Plan

### Phase 1 — Backend Quick Wins (High Impact, Low Risk)

#### 1.1 Fix N+1 Queries in `enrich()`

Replace per-article `getState.get(id)` with a single batch query.

```js
// Before (N queries)
function enrich(items, feedId, feedName) {
  return items.map(item => {
    const st = getState.get(id) || { is_read: 0, is_starred: 0 };
    ...
  });
}

// After (1 query)
function enrich(items, feedId, feedName) {
  const ids = items.map((item, i) =>
    makeId(item.link, item.title, item.pubDate || item.isoDate || String(i))
  );
  const placeholders = ids.map(() => '?').join(',');
  const stateMap = ids.length
    ? Object.fromEntries(
        db.prepare(`SELECT article_id, is_read, is_starred FROM article_states WHERE article_id IN (${placeholders})`).all(...ids)
          .map(r => [r.article_id, r])
      )
    : {};
  return items.map((item, i) => {
    const id = ids[i];
    const st = stateMap[id] || { is_read: 0, is_starred: 0 };
    ...
  });
}
```

#### 1.2 Add Response Compression

```js
// npm install compression
const compression = require('compression');
app.use(compression());
```

Add before all routes. Gzip on article content (often 10–50 KB HTML) saves significant transfer time.

#### 1.3 Add HTTP Caching Headers for Stable Endpoints

```js
// /api/feeds — changes only on user action, safe to cache briefly
app.get('/api/feeds', (_req, res) => {
  res.set('Cache-Control', 'private, max-age=30');
  res.json(db.prepare('SELECT * FROM feeds ORDER BY rowid').all());
});

// /api/starred/count — update on star/unstar, not on every page load
app.get('/api/starred/count', (_req, res) => {
  res.set('Cache-Control', 'private, max-age=10');
  ...
});
```

#### 1.4 Track Cache Warmup Readiness

Add a readiness flag so `/api/today` and `/api/all-articles` can tell the client whether they're serving warm or cold data:

```js
let cacheReady = false;
Promise.allSettled(
  db.prepare('SELECT * FROM feeds').all().map(f => fetchAndCache(f).catch(() => {}))
).then(() => { cacheReady = true; });

// In responses:
res.json({ articles, cacheReady });
```

Client can show a subtle "refreshing…" indicator when `cacheReady === false` rather than blocking.

---

### Phase 2 — Frontend Quick Wins (High Impact, Low Risk)

#### 2.1 Lazy-Load Non-Critical Components

```js
// App.jsx — replace static imports with lazy
import { lazy, Suspense } from 'react';
const AddFeedModal    = lazy(() => import('./components/AddFeedModal'));
const ManageFeedsModal = lazy(() => import('./components/ManageFeedsModal'));
const SettingsModal   = lazy(() => import('./components/SettingsModal'));
const PodcastPlayer   = lazy(() => import('./components/PodcastPlayer'));
```

These are never needed on initial paint. Deferring them shrinks the main bundle and unblocks parsing.

#### 2.2 Memoize `unreadCount`

```js
// App.jsx
import { useMemo } from 'react';
const unreadCount = useMemo(() => articles.filter(a => !a.isRead).length, [articles]);
```

#### 2.3 Change PWA Strategy to StaleWhileRevalidate

```js
// vite.config.js — for article feeds, show stale content immediately
{
  urlPattern: /^\/api\/(today|all-articles|starred)$/,
  handler: 'StaleWhileRevalidate',
  options: {
    cacheName: 'api-articles',
    expiration: { maxEntries: 5, maxAgeSeconds: 60 * 5 },
    cacheableResponse: { statuses: [200] },
  },
},
{
  // Other API calls remain NetworkFirst
  urlPattern: /^\/api\/.*/,
  handler: 'NetworkFirst',
  ...
}
```

On subsequent visits, users see yesterday's articles instantly while fresh ones load in the background.

#### 2.4 Add Skeleton Loading UI

Replace the spinner in `ArticleList.jsx` with 6–8 content-shaped skeleton rows. Eliminates layout shift and communicates structure before data arrives.

```jsx
// Skeleton row — matches ArticleItem layout
function SkeletonItem() {
  return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-light)' }}>
      <div style={{ height: 10, width: '40%', borderRadius: 4, background: 'var(--border)', marginBottom: 6 }} />
      <div style={{ height: 13, width: '90%', borderRadius: 4, background: 'var(--border)', marginBottom: 4 }} />
      <div style={{ height: 13, width: '70%', borderRadius: 4, background: 'var(--border)', marginBottom: 8 }} />
      <div style={{ height: 10, width: '30%', borderRadius: 4, background: 'var(--border)' }} />
    </div>
  );
}
```

---

### Phase 3 — Client-Side Article Cache (Medium Effort, High Impact for UX)

Cache loaded article lists in the Zustand store keyed by view. When switching back to a previously loaded view, show the cached list immediately while re-fetching in the background.

```js
// store.js additions
articleCache: {},   // { 'today': [...], 'all': [...], 'feed:123': [...] }

loadArticles: async (view) => {
  const cacheKey = view.type === 'feed' ? `feed:${view.feed.id}` : view.type;
  const cached = get().articleCache[cacheKey];
  if (cached) set({ articles: cached, loadingArticles: false });  // show immediately
  else set({ loadingArticles: true, articles: [], selectedArticle: null });

  // fetch in background regardless
  const data = await fetch(url, { signal }).then(r => r.json());
  set(state => ({
    articles: data.articles || [],
    articleCache: { ...state.articleCache, [cacheKey]: data.articles || [] },
    loadingArticles: false,
  }));
},
```

---

### Phase 4 — Virtual Scrolling (Low Priority)

Only needed if feed lists grow beyond ~200 articles. Use `@tanstack/react-virtual` for the article list in `ArticleList.jsx`. Defer until feeds scale up.

---

## Priority Order

| Priority | Task | Effort | Impact |
|----------|------|--------|--------|
| 1 | Fix N+1 queries in `enrich()` | 30 min | High — reduces DB load on every article request |
| 2 | Add gzip compression | 15 min | High — article HTML can be 10–50 KB |
| 3 | Lazy-load modals + PodcastPlayer | 20 min | Medium — smaller initial bundle |
| 4 | Skeleton loading UI | 45 min | Medium — better perceived performance |
| 5 | StaleWhileRevalidate in PWA | 15 min | High on repeat visits |
| 6 | Client-side article cache in store | 1 hr | High for navigation UX |
| 7 | HTTP caching headers | 20 min | Low-medium — reduces unnecessary fetches |
| 8 | Cache warmup readiness flag | 30 min | Low — better visibility, not blocking |
| 9 | `useMemo` for unreadCount | 5 min | Negligible — small lists |
| 10 | Virtual scrolling | 2 hr | Low — not needed at current scale |

## Files to Change

- `server/index.js` — phases 1.1, 1.2, 1.3, 1.4
- `client/src/store.js` — phase 3
- `client/src/App.jsx` — phase 2.1, 2.2
- `client/src/components/ArticleList.jsx` — phase 2.4
- `client/vite.config.js` — phase 2.3
