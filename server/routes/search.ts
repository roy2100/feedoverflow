import express from 'express';

import { byPubDateDesc, normalizePubDates } from '../articles.ts';
import { db } from '../db.ts';
import type { Article, ArticleStateRow } from '../types.ts';

export const router = express.Router();

router.get('/api/search', (req, res) => {
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
