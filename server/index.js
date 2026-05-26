process.title = 'rss-reader';
// Needed for proxy TLS compat (local single-user app)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');
const { parseStringPromise } = require('xml2js');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');

const app = express();

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:7890';
const proxyAgent = new HttpsProxyAgent(PROXY_URL, { rejectUnauthorized: false });

function makeParser(signal) {
  return new Parser({
    timeout: 10000,
    headers: { 'User-Agent': 'RSS-Reader/1.0' },
    customFields: { item: [['content:encoded', 'contentEncoded']] },
    requestOptions: { signal, agent: proxyAgent },
  });
}

async function parseURL(url, signal) {
  try {
    return await makeParser(signal).parseURL(url);
  } catch (err) {
    // Trailing-slash URLs trigger a 308 redirect; the second TLS connection after
    // redirect fails with "bad record mac" due to proxy session-resumption issues.
    // Strip the slash to avoid the redirect entirely.
    if (url.endsWith('/')) return makeParser(signal).parseURL(url.slice(0, -1));
    throw err;
  }
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'rss.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS feeds (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS article_states (
    article_id TEXT PRIMARY KEY,
    feed_id    TEXT,
    feed_name  TEXT,
    title      TEXT,
    link       TEXT,
    pub_date   TEXT,
    summary    TEXT,
    content    TEXT,
    author     TEXT,
    is_read    INTEGER DEFAULT 0,
    is_starred INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed default feeds once
if (db.prepare('SELECT COUNT(*) AS n FROM feeds').get().n === 0) {
  const ins = db.prepare('INSERT INTO feeds (id,name,url) VALUES (?,?,?)');
  [
    ['1', '少数派',       'https://sspai.com/feed'],
    ['2', '虎嗅',         'https://feeds.feedburner.com/huxiu'],
    ['3', '36氪',         'https://36kr.com/feed'],
    ['4', '阮一峰的网络日志', 'https://feeds.feedburner.com/ruanyifeng'],
  ].forEach(r => ins.run(...r));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeId(link, title, pubDate) {
  return crypto.createHash('md5')
    .update(link || `${title}${pubDate}`)
    .digest('hex').slice(0, 12);
}

const getState = db.prepare('SELECT is_read, is_starred FROM article_states WHERE article_id = ?');

function dedupById(articles) {
  const seen = new Set();
  return articles.filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; });
}

function enrich(items, feedId, feedName) {
  return items.map((item, i) => {
    const id = makeId(item.link, item.title, item.pubDate || item.isoDate || String(i));
    const st = getState.get(id) || { is_read: 0, is_starred: 0 };
    return {
      id,
      feedId,
      feedName,
      title:   item.title || 'Untitled',
      summary: item.contentSnippet || item.summary || '',
      content: item.contentEncoded || item.content || item.summary || '',
      link:    item.link || '',
      pubDate: item.pubDate || item.isoDate || '',
      author:  item.creator || item.author || '',
      isRead:     !!st.is_read,
      isStarred:  !!st.is_starred,
    };
  });
}

const upsertState = db.prepare(`
  INSERT INTO article_states
    (article_id,feed_id,feed_name,title,link,pub_date,summary,content,author,is_read,is_starred)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(article_id) DO UPDATE SET
    is_read    = CASE WHEN excluded.is_read    IS NOT NULL THEN excluded.is_read    ELSE is_read    END,
    is_starred = CASE WHEN excluded.is_starred IS NOT NULL THEN excluded.is_starred ELSE is_starred END,
    updated_at = datetime('now')
`);

function saveState(article, patch) {
  upsertState.run(
    article.id, article.feedId, article.feedName,
    article.title, article.link, article.pubDate,
    article.summary, article.content, article.author,
    patch.is_read    ?? null,
    patch.is_starred ?? null,
  );
}

// ── Feed cache (stale-while-revalidate) ───────────────────────────────────────
const feedCache = new Map(); // feedId → { items, feedName, fetchedAt }
const CACHE_TTL = 5 * 60 * 1000;

async function fetchAndCache(feed) {
  const parsed = await parseURL(feed.url);
  feedCache.set(feed.id, { items: parsed.items, feedName: parsed.title || feed.name, fetchedAt: Date.now() });
  return feedCache.get(feed.id);
}

async function getCachedFeed(feed, signal) {
  const cached = feedCache.get(feed.id);
  if (!cached) {
    const parsed = await parseURL(feed.url, signal);
    if (signal?.aborted) return null;
    feedCache.set(feed.id, { items: parsed.items, feedName: parsed.title || feed.name, fetchedAt: Date.now() });
    return feedCache.get(feed.id);
  }
  if (Date.now() - cached.fetchedAt >= CACHE_TTL) fetchAndCache(feed).catch(() => {});
  return cached;
}

// Warm cache on startup
db.prepare('SELECT * FROM feeds').all().forEach(f => fetchAndCache(f).catch(() => {}));

// ── Feeds API ─────────────────────────────────────────────────────────────────
app.get('/api/feeds', (_req, res) => {
  res.json(db.prepare('SELECT * FROM feeds ORDER BY rowid').all());
});

app.post('/api/feeds', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  let feedTitle;
  try {
    const parsed = await parseURL(url);
    feedTitle = parsed.title?.trim() || url;
  } catch {
    return res.status(400).json({ error: '无法解析该 Feed，请检查 URL 是否正确' });
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

    const candidates = [];
    function extract(nodes) {
      for (const node of nodes) {
        const attrs = node.$ || {};
        if (attrs.xmlUrl) {
          candidates.push({ name: attrs.text || attrs.title || attrs.xmlUrl, url: attrs.xmlUrl });
        }
        if (node.outline?.length) extract(node.outline);
      }
    }
    extract(bodyOutlines);

    const existingUrls = new Set(db.prepare('SELECT url FROM feeds').all().map(f => f.url));
    const ins = db.prepare('INSERT OR IGNORE INTO feeds (id,name,url) VALUES (?,?,?)');
    const importedFeeds = [];
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
    res.status(400).json({ error: 'Failed to parse OPML', detail: err.message });
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

// ── Full content fetch ────────────────────────────────────────────────────────
app.get('/api/fetch-content', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  const fetchHeaders = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
  try {
    const response = await fetch(url, { agent: proxyAgent, headers: fetchHeaders, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return res.status(502).json({ error: `Upstream ${response.status}` });
    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) return res.status(422).json({ error: 'Could not extract content' });
    res.json({ content: article.content, title: article.title, byline: article.byline });
  } catch (err) {
    res.status(500).json({ error: 'Fetch failed', detail: err.message });
  }
});

// ── Articles API ──────────────────────────────────────────────────────────────
app.get('/api/feeds/:id/articles', async (req, res) => {
  const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(req.params.id);
  if (!feed) return res.status(404).json({ error: 'Not found' });
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  try {
    const cached = await getCachedFeed(feed, ac.signal);
    if (ac.signal.aborted) return;
    res.json({ feedName: cached.feedName, articles: dedupById(enrich(cached.items.slice(0, 50), feed.id, feed.name)) });
  } catch (err) {
    if (ac.signal.aborted) return;
    res.status(500).json({ error: 'Failed to fetch feed', detail: err.message });
  }
});

app.get('/api/all-articles', async (req, res) => {
  const feeds = db.prepare('SELECT * FROM feeds').all();
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  const results = await Promise.allSettled(
    feeds.map(async f => {
      const cached = await getCachedFeed(f, ac.signal);
      return cached ? enrich(cached.items.slice(0, 5), f.id, f.name) : [];
    })
  );
  if (ac.signal.aborted) return;
  const articles = dedupById(results.filter(r => r.status === 'fulfilled').flatMap(r => r.value)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate)));
  res.json({ articles });
});

app.get('/api/today', async (req, res) => {
  const feeds = db.prepare('SELECT * FROM feeds').all();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  const results = await Promise.allSettled(
    feeds.map(async f => {
      const cached = await getCachedFeed(f, ac.signal);
      if (!cached) return [];
      const todayItems = cached.items.filter(item => new Date(item.pubDate || item.isoDate || 0) >= todayStart);
      return enrich(todayItems, f.id, f.name);
    })
  );
  if (ac.signal.aborted) return;
  const articles = dedupById(results.filter(r => r.status === 'fulfilled').flatMap(r => r.value)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate)));
  res.json({ articles });
});

app.get('/api/starred', (_req, res) => {
  const rows = db.prepare('SELECT * FROM article_states WHERE is_starred = 1 ORDER BY updated_at DESC').all();
  res.json({
    articles: rows.map(r => ({
      id: r.article_id, feedId: r.feed_id, feedName: r.feed_name,
      title: r.title, summary: r.summary, content: r.content,
      link: r.link, pubDate: r.pub_date, author: r.author,
      isRead: !!r.is_read, isStarred: true,
    })),
  });
});

// GET /api/starred/count — lightweight count for sidebar badge
app.get('/api/starred/count', (_req, res) => {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM article_states WHERE is_starred = 1').get();
  res.json({ count: n });
});

app.post('/api/articles/read', (req, res) => {
  const { article } = req.body;
  if (!article?.id) return res.status(400).json({ error: 'article required' });
  saveState(article, { is_read: 1 });
  res.json({ ok: true });
});

app.post('/api/articles/star', (req, res) => {
  const { article, starred } = req.body;
  if (!article?.id) return res.status(400).json({ error: 'article required' });
  saveState(article, { is_starred: starred ? 1 : 0 });
  res.json({ ok: true, isStarred: !!starred });
});

const PORT = 3002;
if (require.main === module) {
  app.listen(PORT, () => console.log(`RSS server on http://localhost:${PORT}`));
}

module.exports = { parseURL };
