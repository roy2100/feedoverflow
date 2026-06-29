import crypto from 'node:crypto';

import { parsePubDate, pubTs } from './dates.ts';
import { db } from './db.ts';
import type { RssItem } from './parse-url.ts';
import type { Article, ArticleStateRow, Feed, StatePatch } from './types.ts';

// Re-exported so existing call sites (maintenance, routes) keep importing it from here while
// db.ts pulls the cycle-free copy straight from dates.ts.
export { parsePubDate };

export function makeId(link?: string, title?: string, pubDate?: string): string {
  return crypto
    .createHash('md5')
    .update(link || `${title}${pubDate}`)
    .digest('hex')
    .slice(0, 12);
}

// Descending-by-publish-time comparator. Unparseable dates sort to epoch 0 (bottom) so the
// order is always deterministic — never NaN.
export function byPubDateDesc(a: { pubDate: string }, b: { pubDate: string }): number {
  return (parsePubDate(b.pubDate)?.getTime() ?? 0) - (parsePubDate(a.pubDate)?.getTime() ?? 0);
}

// Rewrite each article's pubDate to canonical ISO-8601 so the client can use native
// `new Date()`. Leaves the raw string untouched when unparseable (client then shows blank).
export function normalizePubDates<T extends { pubDate: string }>(articles: T[]): T[] {
  for (const a of articles) {
    const d = parsePubDate(a.pubDate);
    if (d) a.pubDate = d.toISOString();
  }
  return articles;
}

export function dedupById(articles: Article[]): Article[] {
  const seen = new Set<string>();
  return articles.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

export function normalizeDuration(dur?: string): string {
  if (!dur) return '';
  if (/^\d+:\d{2}(:\d{2})?$/.test(dur)) return dur;
  const secs = parseInt(dur, 10);
  if (isNaN(secs)) return dur;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function enrich(
  items: RssItem[],
  feedId: string,
  feedName: string,
  { withContent = true }: { withContent?: boolean } = {},
): Article[] {
  const ids = items.map((item, i) =>
    makeId(item.link, item.title, item.pubDate || item.isoDate || String(i)),
  );
  const stateMap: Record<string, { is_starred: number }> = ids.length
    ? Object.fromEntries(
        (
          db
            .prepare(
              `SELECT article_id, is_starred FROM article_states WHERE article_id IN (${ids.map(() => '?').join(',')})`,
            )
            .all(...ids) as Array<{ article_id: string; is_starred: number }>
        ).map((r) => [r.article_id, r]),
      )
    : {};
  return items.map((item, i) => {
    const id = ids[i];
    const st = stateMap[id] || { is_starred: 0 };
    const enc = item.enclosure;
    const audioUrl = enc?.url && enc?.type?.startsWith('audio') ? enc.url : '';
    const audioDuration = audioUrl ? normalizeDuration(item.itunes?.duration || '') : '';
    const rawSummary = item.contentSnippet || item.summary || '';
    return {
      id,
      feedId,
      feedName,
      title: item.title || 'Untitled',
      summary: withContent ? rawSummary : rawSummary.slice(0, 300),
      content: withContent ? item.contentEncoded || item.content || item.summary || '' : '',
      link: item.link || '',
      pubDate: item.pubDate || item.isoDate || '',
      author: item.creator || item.author || '',
      audioUrl,
      audioDuration,
      isStarred: !!st.is_starred,
    };
  });
}

// Persist fetched items into article_states. INSERT OR IGNORE only — never overwrites an
// existing row or its starred flag, so it is safe to call from every fetch path (on-demand
// cache miss, background refresh, startup warming, poller). All items are persisted (no cap)
// so article_states is a durable, complete record for offline statistics/research.
const insertPolledArticle = db.prepare(`
  INSERT OR IGNORE INTO article_states
    (article_id,feed_id,feed_name,title,link,pub_date,pub_ts,summary,content,author,audio_url,audio_duration,is_starred)
  VALUES (@id,@feedId,@feedName,@title,@link,@pubDate,@pubTs,@summary,@content,@author,@audioUrl,@audioDuration,0)
`);

export function persistItems(feed: Feed, items: RssItem[], feedName: string): void {
  const enriched = enrich(items, feed.id, feedName, { withContent: true });
  const now = Date.now();
  db.transaction(() => {
    for (const a of enriched) {
      insertPolledArticle.run({
        id: a.id,
        feedId: a.feedId,
        feedName: a.feedName,
        title: a.title,
        link: a.link,
        pubDate: a.pubDate,
        pubTs: pubTs(a.pubDate, now),
        summary: a.summary,
        content: a.content,
        author: a.author,
        audioUrl: a.audioUrl || null,
        audioDuration: a.audioDuration || null,
      });
    }
  })();
}

// Map a persisted row to the API Article shape. List endpoints pass withContent:false to
// strip the body (and cap the summary) the way enrich() does for live items; starred reads
// keep the full body.
export function rowToArticle(r: ArticleStateRow, { withContent = false } = {}): Article {
  const summary = r.summary || '';
  return {
    id: r.article_id,
    feedId: r.feed_id,
    feedName: r.feed_name,
    title: r.title,
    summary: withContent ? summary : summary.slice(0, 300),
    content: withContent ? r.content || '' : '',
    link: r.link,
    pubDate: r.pub_date,
    author: r.author || '',
    audioUrl: r.audio_url || '',
    audioDuration: r.audio_duration || '',
    isStarred: !!r.is_starred,
  };
}

export function resolveUrl(url: string): string {
  if (!url || !url.startsWith('rsshub://')) return url;
  const base =
    (
      db.prepare("SELECT value FROM settings WHERE key = 'rsshub_base_url'").get() as
        | { value?: string }
        | undefined
    )?.value || 'http://localhost:1200';
  return base.replace(/\/$/, '') + '/' + url.slice('rsshub://'.length);
}

// Body lives only in article_states.content — every fetched item is persisted there with its
// body (persistItems, withContent: true), so this single lookup covers every article.
export function lookupContent(articleId: string): string {
  const saved = db
    .prepare('SELECT content FROM article_states WHERE article_id = ?')
    .get(articleId) as { content?: string } | undefined;
  return saved?.content || '';
}

const upsertState = db.prepare(`
  INSERT INTO article_states
    (article_id,feed_id,feed_name,title,link,pub_date,pub_ts,summary,content,author,audio_url,audio_duration,is_starred)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(article_id) DO UPDATE SET
    audio_url      = COALESCE(excluded.audio_url, audio_url),
    audio_duration = COALESCE(excluded.audio_duration, audio_duration),
    is_starred = CASE WHEN excluded.is_starred IS NOT NULL THEN excluded.is_starred ELSE is_starred END,
    updated_at = datetime('now')
`);

export function saveState(article: Article, patch: StatePatch): void {
  upsertState.run(
    article.id,
    article.feedId,
    article.feedName,
    article.title,
    article.link,
    article.pubDate,
    pubTs(article.pubDate, Date.now()),
    article.summary,
    article.content,
    article.author,
    article.audioUrl || null,
    article.audioDuration || null,
    patch.is_starred ?? null,
  );
}
