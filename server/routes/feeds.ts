import crypto from 'node:crypto';

import express from 'express';
import { parseStringPromise } from 'xml2js';

import {
  resolveUrl,
  rowToArticle,
  normalizePubDates,
  adoptStarredOrphans,
  LIST_LIMIT,
} from '../articles.ts';
import { ensureFresh } from '../cache.ts';
import { db } from '../db.ts';
import { parseURL } from '../parse-url.ts';
import type { Feed, ArticleStateRow } from '../types.ts';

export const router = express.Router();

router.get('/api/feeds', (_req, res) => {
  res.set('Cache-Control', 'private, max-age=30');
  res.json(db.prepare('SELECT * FROM feeds ORDER BY rowid').all());
});

router.post('/api/feeds', async (req, res) => {
  const { url, name } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  // Feed URLs are unique (idx_feeds_url). Reject a dupe up front with a clear message rather
  // than parsing the feed and letting the INSERT throw a raw SQLite constraint error.
  if (db.prepare('SELECT 1 FROM feeds WHERE url = ?').get(url)) {
    return res.status(409).json({ error: '该 Feed 已存在' });
  }
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
  try {
    db.prepare('INSERT INTO feeds (id,name,url) VALUES (?,?,?)').run(id, feedTitle, url);
  } catch (err) {
    // Backstop for a race: two concurrent adds of the same new URL can both pass the SELECT
    // above; the unique index makes the second INSERT throw. Surface it as a 409, not a 500.
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: '该 Feed 已存在' });
    }
    throw err;
  }
  // Re-adopt any starred articles orphaned by a prior delete of this same URL.
  adoptStarredOrphans(id, feedTitle, url);
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
      adoptStarredOrphans(id, feed.name, feed.url);
      importedFeeds.push({ id, ...feed });
      existingUrls.add(feed.url);
    }
    res.json({ imported: importedFeeds.length, skipped, feeds: importedFeeds });
  } catch (err) {
    res.status(400).json({ error: 'Failed to parse OPML', detail: (err as Error).message });
  }
});

router.patch('/api/feeds/:id', (req, res) => {
  // feeds.name is NOT NULL, so reject an empty rename up front rather than letting
  // `name || null` reach the UPDATE and throw the constraint (a 500).
  const name = (typeof req.body?.name === 'string' && req.body.name.trim()) || '';
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = db
    .prepare('UPDATE feeds SET name = ? WHERE id = ?')
    .run(name, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

const deleteFeed = db.transaction((id: string): number => {
  const info = db.prepare('DELETE FROM feeds WHERE id = ?').run(id);
  if (info.changes === 0) return 0;
  // Purge the feed's non-starred articles so a re-add starts from a clean slate. Starred
  // rows are kept (bookmarks survive feed removal, per the durable-record design) — they
  // become orphans the periodic maintenance pass also leaves alone.
  db.prepare('DELETE FROM article_states WHERE feed_id = ? AND is_starred = 0').run(id);
  return info.changes;
});

router.delete('/api/feeds/:id', (req, res) => {
  if (deleteFeed(req.params.id) === 0) return res.status(404).json({ error: 'Not found' });
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
    await ensureFresh(feed);
    if (ac.signal.aborted) return;
    // article_states is the durable record of every fetched item; read the feed's newest
    // LIST_LIMIT rows straight from it (pub_ts is the sortable publish time). No live/historic
    // merge needed — refreshFeed already persisted the latest fetch into the same table.
    const rows = db
      .prepare('SELECT * FROM article_states WHERE feed_id = ? ORDER BY pub_ts DESC LIMIT ?')
      .all(feed.id, LIST_LIMIT) as ArticleStateRow[];
    const articles = rows.map((r) => rowToArticle(r));
    res.json({ feedName: feed.name, articles: normalizePubDates(articles) });
  } catch (err) {
    if (ac.signal.aborted) return;
    res.status(500).json({ error: 'Failed to fetch feed', detail: (err as Error).message });
  }
});
