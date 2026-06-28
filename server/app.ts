import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import compression from 'compression';
import cors from 'cors';
import express from 'express';
import { parseStringPromise } from 'xml2js';

import {
  dedupById,
  enrich,
  resolveUrl,
  lookupContent,
  saveState,
  parsePubDate,
  byPubDateDesc,
  normalizePubDates,
} from './articles.ts';
import { registerAuth } from './auth.ts';
import { getCachedFeed, clearCache, cacheReady } from './cache.ts';
import { db } from './db.ts';
import { getFavicon, DEFAULT_FAVICON, DEFAULT_CONTENT_TYPE } from './favicon.ts';
import { registerMcp } from './mcp.ts';
import { parseURL } from './parse-url.ts';
import { assertSafeUrl } from './ssrf.ts';
import type { Feed, Article, ArticleStateRow } from './types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../client/dist');

const ALLOWED_ORIGINS = ['http://localhost:3000', 'https://rss.royl.uk', 'https://rss.lan'];

export const app = express();
// Behind the Cloudflare Tunnel, cloudflared connects from 127.0.0.1, so without
// this the real client IP is masked and every public request looks like localhost.
// Trust the loopback hop to read the real IP from cloudflared's X-Forwarded-For.
app.set('trust proxy', 'loopback');
app.use(compression());
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(distDir));

registerAuth(app);

// ── Feeds ──────────────────────────────────────────────────────────────────────

app.get('/api/feeds', (_req, res) => {
  res.set('Cache-Control', 'private, max-age=30');
  res.json(db.prepare('SELECT * FROM feeds ORDER BY rowid').all());
});

app.post('/api/feeds', async (req, res) => {
  const { url, name } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  let feedTitle: string;
  try {
    const parsed = await parseURL(resolveUrl(url));
    feedTitle = (typeof name === 'string' && name.trim()) || parsed.title?.trim() || url;
  } catch (err) {
    return res.status(400).json({
      error: '无法解析该 Feed，请检查 URL 是否正确',
      detail: (err as Error)?.message || String(err),
    });
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO feeds (id,name,url) VALUES (?,?,?)').run(id, feedTitle, url);
  res.json({ id, name: feedTitle, url });
});

app.post('/api/feeds/import-opml', async (req, res) => {
  const { opml } = req.body;
  if (!opml) return res.status(400).json({ error: 'opml content required' });
  try {
    const parsed = await parseStringPromise(opml, { explicitArray: true });
    const bodyOutlines = parsed?.opml?.body?.[0]?.outline || [];
    const candidates: Array<{ name: string; url: string }> = [];
    function extract(nodes: any[]) {
      for (const node of nodes) {
        const attrs = node.$ || {};
        if (attrs.xmlUrl)
          candidates.push({ name: attrs.text || attrs.title || attrs.xmlUrl, url: attrs.xmlUrl });
        if (node.outline?.length) extract(node.outline);
      }
    }
    extract(bodyOutlines);
    const existingUrls = new Set(
      (db.prepare('SELECT url FROM feeds').all() as Array<{ url: string }>).map((f) => f.url),
    );
    const ins = db.prepare('INSERT OR IGNORE INTO feeds (id,name,url) VALUES (?,?,?)');
    const importedFeeds: Array<{ id: string; name: string; url: string }> = [];
    let skipped = 0;
    for (const feed of candidates) {
      if (existingUrls.has(feed.url)) {
        skipped++;
        continue;
      }
      const id = crypto.randomUUID();
      ins.run(id, feed.name, feed.url);
      importedFeeds.push({ id, ...feed });
      existingUrls.add(feed.url);
    }
    res.json({ imported: importedFeeds.length, skipped, feeds: importedFeeds });
  } catch (err) {
    res.status(400).json({ error: 'Failed to parse OPML', detail: (err as Error).message });
  }
});

app.patch('/api/feeds/:id', (req, res) => {
  const { name } = req.body;
  const info = db
    .prepare('UPDATE feeds SET name = ? WHERE id = ?')
    .run(name || null, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.delete('/api/feeds/:id', (req, res) => {
  const info = db.prepare('DELETE FROM feeds WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Settings ───────────────────────────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
    key: string;
    value: string;
  }>;
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

app.patch('/api/settings', (req, res) => {
  const allowed = ['rsshub_base_url'];
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const key of allowed) {
    if (key in req.body) upsert.run(key, String(req.body[key]).trim());
  }
  clearCache.run();
  res.json({ ok: true });
});

// ── Full content fetch ─────────────────────────────────────────────────────────

app.get('/api/fetch-content', async (req, res) => {
  const url = req.query.url as string | undefined;
  if (!url) return res.status(400).json({ error: 'url required' });
  // This endpoint fetches a client-supplied URL, so block private/loopback/metadata
  // targets (SSRF defense-in-depth).
  try {
    await assertSafeUrl(url);
  } catch (err) {
    return res.status(400).json({ error: 'Blocked URL', detail: (err as Error).message });
  }
  const fetchHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  try {
    const response = await fetch(url, {
      headers: fetchHeaders,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return res.status(502).json({ error: `Upstream ${response.status}` });
    const html = await response.text();
    // jsdom + Readability are ~100MB resident and only needed for this on-demand
    // extraction, so load them lazily on first use instead of at boot. Node caches the
    // modules after the first import, so subsequent requests pay nothing.
    const { JSDOM } = await import('jsdom');
    const { Readability } = await import('@mozilla/readability');
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) return res.status(422).json({ error: 'Could not extract content' });
    res.json({ content: article.content, title: article.title, byline: article.byline });
  } catch (err) {
    res.status(500).json({ error: 'Fetch failed', detail: (err as Error).message });
  }
});

app.get('/api/favicon', async (req, res) => {
  const domain = (req.query.domain as string | undefined) ?? '';
  let result = null;
  try {
    result = await getFavicon(domain);
  } catch {
    /* fall through to default */
  }
  if (result) {
    res.set('Cache-Control', 'public, max-age=604800'); // overrides the global /api no-store
    res.type(result.contentType).send(result.image);
  } else {
    // A missing favicon is normal — serve a placeholder (200) so the browser logs no
    // error. Short TTL so a real icon is picked up once the negative cache expires.
    res.set('Cache-Control', 'public, max-age=86400');
    res.type(DEFAULT_CONTENT_TYPE).send(DEFAULT_FAVICON);
  }
});

// ── Articles ───────────────────────────────────────────────────────────────────

app.get('/api/feeds/:id/articles', async (req, res) => {
  const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(req.params.id) as
    | Feed
    | undefined;
  if (!feed) return res.status(404).json({ error: 'Not found' });
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  try {
    const cached = await getCachedFeed(feed, ac.signal);
    if (ac.signal.aborted || !cached) return;
    const liveArticles = enrich(cached.items.slice(0, 50), feed.id, feed.name, {
      withContent: false,
    });
    const liveIds = new Set(liveArticles.map((a) => a.id));
    const persisted = db
      .prepare('SELECT * FROM article_states WHERE feed_id = ? ORDER BY pub_date DESC')
      .all(feed.id) as ArticleStateRow[];
    const historicArticles: Article[] = persisted
      .filter((r) => !liveIds.has(r.article_id))
      .map((r) => ({
        id: r.article_id,
        feedId: r.feed_id,
        feedName: r.feed_name,
        title: r.title,
        summary: (r.summary || '').slice(0, 300),
        content: '',
        link: r.link,
        pubDate: r.pub_date,
        author: r.author || '',
        audioUrl: r.audio_url || '',
        audioDuration: r.audio_duration || '',
        isStarred: !!r.is_starred,
      }));
    const articles = dedupById([...liveArticles, ...historicArticles]);
    articles.sort(byPubDateDesc);
    res.json({ feedName: cached.feedName, articles: normalizePubDates(articles) });
  } catch (err) {
    if (ac.signal.aborted) return;
    res.status(500).json({ error: 'Failed to fetch feed', detail: (err as Error).message });
  }
});

app.get('/api/all-articles', async (req, res) => {
  const feeds = db.prepare('SELECT * FROM feeds').all() as Feed[];
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  const results = await Promise.allSettled(
    feeds.map(async (f) => {
      const cached = await getCachedFeed(f, ac.signal);
      return cached ? enrich(cached.items.slice(0, 5), f.id, f.name, { withContent: false }) : [];
    }),
  );
  if (ac.signal.aborted) return;
  const articles = dedupById(
    results
      .filter((r): r is PromiseFulfilledResult<Article[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value)
      .sort(byPubDateDesc),
  );
  res.json({ articles: normalizePubDates(articles), cacheReady });
});

app.get('/api/today', async (req, res) => {
  const feeds = db.prepare('SELECT * FROM feeds').all() as Feed[];
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  const results = await Promise.allSettled(
    feeds.map(async (f) => {
      const cached = await getCachedFeed(f, ac.signal);
      if (!cached) return [];
      const todayItems = cached.items.filter(
        (item) =>
          (parsePubDate(item.pubDate || item.isoDate)?.getTime() ?? 0) >= todayStart.getTime(),
      );
      return enrich(todayItems, f.id, f.name, { withContent: false });
    }),
  );
  if (ac.signal.aborted) return;
  const articles = dedupById(
    results
      .filter((r): r is PromiseFulfilledResult<Article[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value)
      .sort(byPubDateDesc),
  );
  res.json({ articles: normalizePubDates(articles), cacheReady });
});

app.get('/api/starred', (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM article_states WHERE is_starred = 1 ORDER BY updated_at DESC')
    .all() as ArticleStateRow[];
  res.json({
    articles: normalizePubDates(
      rows.map((r) => ({
        id: r.article_id,
        feedId: r.feed_id,
        feedName: r.feed_name,
        title: r.title,
        summary: r.summary,
        content: r.content,
        link: r.link,
        pubDate: r.pub_date,
        author: r.author,
        audioUrl: r.audio_url || '',
        audioDuration: r.audio_duration || '',
        isStarred: true,
      })),
    ),
  });
});

// Recently-updated podcasts across all feeds: every fetched item carrying an audio
// enclosure is persisted in article_states with a non-empty audio_url, so a single SQL
// scan covers it. (pub_date is an RFC-822 string, so the SQL ORDER BY is only a coarse
// text sort — re-sort by parsed date in JS before slicing, like the other list endpoints.)
app.get('/api/podcasts', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM article_states
       WHERE audio_url IS NOT NULL AND audio_url != ''
       ORDER BY pub_date DESC LIMIT 200`,
    )
    .all() as ArticleStateRow[];
  const articles: Article[] = rows
    .map((r) => ({
      id: r.article_id,
      feedId: r.feed_id,
      feedName: r.feed_name,
      title: r.title,
      summary: (r.summary || '').slice(0, 300),
      content: '',
      link: r.link,
      pubDate: r.pub_date,
      author: r.author || '',
      audioUrl: r.audio_url || '',
      audioDuration: r.audio_duration || '',
      isStarred: !!r.is_starred,
    }))
    .sort(byPubDateDesc)
    .slice(0, 100);
  normalizePubDates(articles);
  res.json({ articles });
});

app.get('/api/starred/count', (_req, res) => {
  res.set('Cache-Control', 'private, max-age=10');
  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM article_states WHERE is_starred = 1')
    .get() as { n: number };
  res.json({ count: n });
});

// ── Search ───────────────────────────────────────────────────────────────────

app.get('/api/search', (req, res) => {
  const q = ((req.query.q as string | undefined) || '').trim();
  if (q.length < 2) return res.json({ articles: [], query: q });

  // Optional scope: restrict to starred articles or one feed (pure SQL filters). Any other
  // value (or none) means a global search across all fetched articles.
  const scope = req.query.scope as string | undefined;
  const feedId = req.query.feedId as string | undefined;
  let scopeClause = '';
  const scopeParams: string[] = [];
  if (scope === 'starred') {
    scopeClause = ' AND is_starred = 1';
  } else if (scope === 'feed' && feedId) {
    scopeClause = ' AND feed_id = ?';
    scopeParams.push(feedId);
  }

  // article_states durably holds title/summary/content for every fetched + starred article,
  // so a single SQL LIKE covers search with no live fetch. (pub_date is an RFC-822 string, so
  // the SQL ORDER BY is only a coarse text sort — re-sort by parsed date in JS before slicing.)
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = db
    .prepare(
      `SELECT * FROM article_states
       WHERE (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')${scopeClause}
       ORDER BY pub_date DESC LIMIT 200`,
    )
    .all(like, like, like, ...scopeParams) as ArticleStateRow[];
  const articles: Article[] = rows
    .map((r) => ({
      id: r.article_id,
      feedId: r.feed_id,
      feedName: r.feed_name,
      title: r.title,
      summary: (r.summary || '').slice(0, 300),
      content: '',
      link: r.link,
      pubDate: r.pub_date,
      author: r.author || '',
      audioUrl: r.audio_url || '',
      audioDuration: r.audio_duration || '',
      isStarred: !!r.is_starred,
    }))
    .sort(byPubDateDesc)
    .slice(0, 100);
  normalizePubDates(articles);
  res.json({ articles, query: q });
});

app.post('/api/articles/star', (req, res) => {
  const { article, starred } = req.body;
  if (!article?.id) return res.status(400).json({ error: 'article required' });
  const content = article.content || lookupContent(article.id);
  saveState({ ...article, content }, { is_starred: starred ? 1 : 0 });
  res.json({ ok: true, isStarred: !!starred });
});

app.get('/api/articles/:id/content', (req, res) => {
  const content = lookupContent(req.params.id);
  res.json({ content });
});

// In-memory current article — tracks what's open in the UI
let currentArticle: unknown = null;

app.get('/api/current-article', (_req, res) => {
  if (!currentArticle) return res.status(404).json({ error: 'no article open' });
  res.json(currentArticle);
});

app.post('/api/current-article', (req, res) => {
  currentArticle = req.body?.article ?? null;
  res.json({ ok: true });
});

// MCP server over Streamable HTTP — must be before the SPA fallback
registerMcp(app);

// SPA fallback — must be after all /api routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

// Background services (cache warming, poller, DB maintenance) are started by index.ts
// only after the server successfully binds its port — not at import time.
