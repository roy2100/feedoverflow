import express from 'express';

import {
  dedupById,
  lookupContent,
  rowToArticle,
  saveState,
  byPubDateDesc,
  normalizePubDates,
  LIST_LIMIT,
} from '../articles.ts';
import { ensureFresh, cacheReady } from '../cache.ts';
import { db } from '../db.ts';
import type { Feed, ArticleStateRow } from '../types.ts';

export const router = express.Router();

// Newest N persisted rows for a feed (pub_ts is the sortable publish time).
const newestByFeed = db.prepare(
  'SELECT * FROM article_states WHERE feed_id = ? ORDER BY pub_ts DESC LIMIT ?',
);
// A feed's newest rows published since a cutoff (epoch ms). LIMIT-capped per feed so one
// firehose feed can't dominate, and so /api/today never materializes thousands of rows.
const sinceByFeed = db.prepare(
  'SELECT * FROM article_states WHERE feed_id = ? AND pub_ts >= ? ORDER BY pub_ts DESC LIMIT ?',
);

router.get('/api/all-articles', async (req, res) => {
  const feeds = db.prepare('SELECT * FROM feeds').all() as Feed[];
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  await Promise.allSettled(feeds.map((f) => ensureFresh(f, ac.signal)));
  if (ac.signal.aborted) return;
  const articles = dedupById(
    feeds
      .flatMap((f) =>
        (newestByFeed.all(f.id, LIST_LIMIT) as ArticleStateRow[]).map((r) => rowToArticle(r)),
      )
      .sort(byPubDateDesc),
  ).slice(0, LIST_LIMIT);
  res.json({ articles: normalizePubDates(articles), cacheReady });
});

router.get('/api/today', async (req, res) => {
  const feeds = db.prepare('SELECT * FROM feeds').all() as Feed[];
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  await Promise.allSettled(feeds.map((f) => ensureFresh(f, ac.signal)));
  if (ac.signal.aborted) return;
  const articles = dedupById(
    feeds
      .flatMap((f) =>
        (sinceByFeed.all(f.id, todayStart.getTime(), LIST_LIMIT) as ArticleStateRow[]).map((r) =>
          rowToArticle(r),
        ),
      )
      .sort(byPubDateDesc),
  ).slice(0, LIST_LIMIT);
  res.json({ articles: normalizePubDates(articles), cacheReady });
});

router.get('/api/starred', (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM article_states WHERE is_starred = 1 ORDER BY updated_at DESC')
    .all() as ArticleStateRow[];
  res.json({
    articles: normalizePubDates(rows.map((r) => rowToArticle(r, { withContent: true }))),
  });
});

// Recently-updated podcasts across all feeds: every fetched item carrying an audio
// enclosure is persisted in article_states with a non-empty audio_url, so a single SQL
// scan covers it. (pub_date is an RFC-822 string, so the SQL ORDER BY is only a coarse
// text sort — re-sort by parsed date in JS before slicing, like the other list endpoints.)
router.get('/api/podcasts', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM article_states
       WHERE audio_url IS NOT NULL AND audio_url != ''
       ORDER BY pub_date DESC LIMIT 200`,
    )
    .all() as ArticleStateRow[];
  const articles = rows
    .map((r) => rowToArticle(r))
    .sort(byPubDateDesc)
    .slice(0, 100);
  normalizePubDates(articles);
  res.json({ articles });
});

router.get('/api/starred/count', (_req, res) => {
  res.set('Cache-Control', 'private, max-age=10');
  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM article_states WHERE is_starred = 1')
    .get() as { n: number };
  res.json({ count: n });
});

router.post('/api/articles/star', (req, res) => {
  const { article, starred } = req.body;
  if (!article?.id) return res.status(400).json({ error: 'article required' });
  const content = article.content || lookupContent(article.id);
  saveState({ ...article, content }, { is_starred: starred ? 1 : 0 });
  res.json({ ok: true, isStarred: !!starred });
});

router.get('/api/articles/:id/content', (req, res) => {
  const content = lookupContent(req.params.id);
  res.json({ content });
});

// In-memory current article — tracks what's open in the UI
let currentArticle: unknown = null;

router.get('/api/current-article', (_req, res) => {
  if (!currentArticle) return res.status(404).json({ error: 'no article open' });
  res.json(currentArticle);
});

router.post('/api/current-article', (req, res) => {
  currentArticle = req.body?.article ?? null;
  res.json({ ok: true });
});
