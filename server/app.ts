import express from 'express';
import compression from 'compression';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStringPromise } from 'xml2js';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

import { db } from './db.ts';
import { parseURL } from './parse-url.ts';
import { registerAuth } from './auth.ts';
import { dedupById, enrich, resolveUrl, lookupContent, saveState } from './articles.ts';
import { getCachedFeed, clearCache, cacheReady, startCacheWarming } from './cache.ts';
import { startPoller } from './poller.ts';
import { registerMcp } from './mcp.ts';
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
    return res.status(400).json({ error: '无法解析该 Feed，请检查 URL 是否正确', detail: (err as Error)?.message || String(err) });
  }
  const id = Date.now().toString();
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
        if (attrs.xmlUrl) candidates.push({ name: attrs.text || attrs.title || attrs.xmlUrl, url: attrs.xmlUrl });
        if (node.outline?.length) extract(node.outline);
      }
    }
    extract(bodyOutlines);
    const existingUrls = new Set((db.prepare('SELECT url FROM feeds').all() as Array<{ url: string }>).map(f => f.url));
    const ins = db.prepare('INSERT OR IGNORE INTO feeds (id,name,url) VALUES (?,?,?)');
    const importedFeeds: Array<{ id: string; name: string; url: string }> = [];
    let skipped = 0;
    for (const feed of candidates) {
      if (existingUrls.has(feed.url)) { skipped++; continue; }
      const id = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
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
  const info = db.prepare('UPDATE feeds SET name = ? WHERE id = ?').run(name || null, req.params.id);
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
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
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
  const fetchHeaders = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
  try {
    const response = await fetch(url, { headers: fetchHeaders, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return res.status(502).json({ error: `Upstream ${response.status}` });
    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) return res.status(422).json({ error: 'Could not extract content' });
    res.json({ content: article.content, title: article.title, byline: article.byline });
  } catch (err) {
    res.status(500).json({ error: 'Fetch failed', detail: (err as Error).message });
  }
});

// ── Articles ───────────────────────────────────────────────────────────────────

app.get('/api/feeds/:id/articles', async (req, res) => {
  const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(req.params.id) as Feed | undefined;
  if (!feed) return res.status(404).json({ error: 'Not found' });
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  try {
    const cached = await getCachedFeed(feed, ac.signal);
    if (ac.signal.aborted || !cached) return;
    const liveArticles = enrich(cached.items.slice(0, 50), feed.id, feed.name, { withContent: false });
    const liveIds = new Set(liveArticles.map(a => a.id));
    const persisted = db.prepare(
      'SELECT * FROM article_states WHERE feed_id = ? ORDER BY pub_date DESC'
    ).all(feed.id) as ArticleStateRow[];
    const historicArticles: Article[] = persisted
      .filter(r => !liveIds.has(r.article_id))
      .map(r => ({
        id: r.article_id, feedId: r.feed_id, feedName: r.feed_name,
        title: r.title, summary: (r.summary || '').slice(0, 300), content: '',
        link: r.link, pubDate: r.pub_date, author: r.author || '',
        audioUrl: r.audio_url || '', audioDuration: r.audio_duration || '',
        isRead: !!r.is_read, isStarred: !!r.is_starred,
      }));
    const articles = dedupById([...liveArticles, ...historicArticles]);
    articles.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
    res.json({ feedName: cached.feedName, articles });
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
    feeds.map(async f => {
      const cached = await getCachedFeed(f, ac.signal);
      return cached ? enrich(cached.items.slice(0, 5), f.id, f.name, { withContent: false }) : [];
    })
  );
  if (ac.signal.aborted) return;
  const articles = dedupById(
    results
      .filter((r): r is PromiseFulfilledResult<Article[]> => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
  );
  res.json({ articles, cacheReady });
});

app.get('/api/today', async (req, res) => {
  const feeds = db.prepare('SELECT * FROM feeds').all() as Feed[];
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  const results = await Promise.allSettled(
    feeds.map(async f => {
      const cached = await getCachedFeed(f, ac.signal);
      if (!cached) return [];
      const todayItems = cached.items.filter(item =>
        new Date(item.pubDate || item.isoDate || 0).getTime() >= todayStart.getTime()
      );
      return enrich(todayItems, f.id, f.name, { withContent: false });
    })
  );
  if (ac.signal.aborted) return;
  const articles = dedupById(
    results
      .filter((r): r is PromiseFulfilledResult<Article[]> => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
  );
  res.json({ articles, cacheReady });
});

app.get('/api/starred', (_req, res) => {
  const rows = db.prepare('SELECT * FROM article_states WHERE is_starred = 1 ORDER BY updated_at DESC').all() as ArticleStateRow[];
  res.json({
    articles: rows.map(r => ({
      id: r.article_id, feedId: r.feed_id, feedName: r.feed_name,
      title: r.title, summary: r.summary, content: r.content,
      link: r.link, pubDate: r.pub_date, author: r.author,
      audioUrl: r.audio_url || '', audioDuration: r.audio_duration || '',
      isRead: !!r.is_read, isStarred: true,
    })),
  });
});

app.get('/api/unread-counts', (_req, res) => {
  const rows = db.prepare(
    'SELECT feed_id, COUNT(*) AS count FROM article_states WHERE is_read = 0 GROUP BY feed_id'
  ).all() as Array<{ feed_id: string; count: number }>;
  res.json(Object.fromEntries(rows.map(r => [r.feed_id, r.count])));
});

app.get('/api/starred/count', (_req, res) => {
  res.set('Cache-Control', 'private, max-age=10');
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM article_states WHERE is_starred = 1').get() as { n: number };
  res.json({ count: n });
});

app.post('/api/articles/read', (req, res) => {
  const { article } = req.body;
  if (!article?.id) return res.status(400).json({ error: 'article required' });
  const content = article.content || lookupContent(article.id, article.feedId);
  saveState({ ...article, content }, { is_read: 1 });
  res.json({ ok: true });
});

app.post('/api/articles/star', (req, res) => {
  const { article, starred } = req.body;
  if (!article?.id) return res.status(400).json({ error: 'article required' });
  const content = article.content || lookupContent(article.id, article.feedId);
  saveState({ ...article, content }, { is_starred: starred ? 1 : 0 });
  res.json({ ok: true, isStarred: !!starred });
});

app.get('/api/articles/:id/content', (req, res) => {
  const content = lookupContent(req.params.id, req.query.feedId as string | undefined);
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

// Start background services (no-op when TEST_DB is set)
startCacheWarming();
startPoller();
