import { db } from './db.ts';
import { enrich } from './articles.ts';
import { fetchAndCache } from './cache.ts';
import type { Feed } from './types.ts';
import type { RssItem } from './parse-url.ts';

const POLL_INTERVAL = 15 * 60 * 1000;

const insertPolledArticle = db.prepare(`
  INSERT OR IGNORE INTO article_states
    (article_id,feed_id,feed_name,title,link,pub_date,summary,content,author,audio_url,audio_duration,is_read,is_starred)
  VALUES (@id,@feedId,@feedName,@title,@link,@pubDate,@summary,@content,@author,@audioUrl,@audioDuration,@isRead,0)
`);

export function persistPolled(
  feed: Feed,
  items: RssItem[],
  feedName: string,
  { markRead = false }: { markRead?: boolean } = {},
): void {
  const enriched = enrich(items.slice(0, 50), feed.id, feedName, { withContent: true });
  db.transaction(() => {
    for (const a of enriched) {
      insertPolledArticle.run({
        id: a.id, feedId: a.feedId, feedName: a.feedName,
        title: a.title, link: a.link, pubDate: a.pubDate,
        summary: a.summary, content: a.content, author: a.author,
        audioUrl: a.audioUrl || null, audioDuration: a.audioDuration || null,
        isRead: markRead ? 1 : 0,
      });
    }
  })();
}

async function pollFeed(feed: Feed, { markRead = false }: { markRead?: boolean } = {}): Promise<void> {
  try {
    const { items, feedName } = await fetchAndCache(feed);
    persistPolled(feed, items, feedName, { markRead });
  } catch (err) {
    console.error(`[poller] ${feed.url}: ${(err as Error).message}`);
  }
}

async function pollAllFeeds(): Promise<void> {
  const feeds = db.prepare('SELECT * FROM feeds').all() as Feed[];
  for (let i = 0; i < feeds.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
    await pollFeed(feeds[i]);
  }
}

export function startPoller(): void {
  if (process.env.TEST_DB) return;
  setTimeout(async () => {
    const feeds = db.prepare('SELECT * FROM feeds').all() as Feed[];
    for (const feed of feeds) {
      const hasStates = !!db.prepare('SELECT 1 FROM article_states WHERE feed_id = ? LIMIT 1').get(feed.id);
      await pollFeed(feed, { markRead: !hasStates });
    }
    setInterval(pollAllFeeds, POLL_INTERVAL);
  }, 5000);
}
