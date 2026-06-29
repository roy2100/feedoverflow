import crypto from 'node:crypto';

import express from 'express';
import { parseStringPromise } from 'xml2js';

import { dedupById, enrich, resolveUrl, byPubDateDesc, normalizePubDates } from '../articles.ts';
import { getCachedFeed } from '../cache.ts';
import { db } from '../db.ts';
import { parseURL } from '../parse-url.ts';
import type { Feed, Article, ArticleStateRow } from '../types.ts';

export const router = express.Router();

router.get('/api/feeds', (_req, res) => {
  res.set('Cache-Control', 'private, max-age=30');
  res.json(db.prepare('SELECT * FROM feeds ORDER BY rowid').all());
});

router.post('/api/feeds', async (req, res) => {
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

router.post('/api/feeds/import-opml', async (req, res) => {
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

router.patch('/api/feeds/:id', (req, res) => {
  const { name } = req.body;
  const info = db
    .prepare('UPDATE feeds SET name = ? WHERE id = ?')
    .run(name || null, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.delete('/api/feeds/:id', (req, res) => {
  const info = db.prepare('DELETE FROM feeds WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.get('/api/feeds/:id/articles', async (req, res) => {
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
