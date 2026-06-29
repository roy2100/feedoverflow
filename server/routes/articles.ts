import express from 'express';

import {
  dedupById,
  enrich,
  lookupContent,
  saveState,
  parsePubDate,
  byPubDateDesc,
  normalizePubDates,
} from '../articles.ts';
import { getCachedFeed, cacheReady } from '../cache.ts';
import { db } from '../db.ts';
import type { Feed, Article, ArticleStateRow } from '../types.ts';

export const router = express.Router();

router.get('/api/all-articles', async (req, res) => {
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

router.get('/api/today', async (req, res) => {
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

router.get('/api/starred', (_req, res) => {
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
router.get('/api/podcasts', (_req, res) => {
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
