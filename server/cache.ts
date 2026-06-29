import { persistItems, resolveUrl } from './articles.ts';
import { db } from './db.ts';
import { logger } from './logger.ts';
import { parseURL } from './parse-url.ts';
import type { RssItem } from './parse-url.ts';
import type { Feed } from './types.ts';

const log = logger.child({ mod: 'cache' });

export const CACHE_TTL = 5 * 60 * 1000;

const setFetchedAt = db.prepare('UPDATE feeds SET last_fetched_at = ? WHERE id = ?');
const feedHasRows = db.prepare('SELECT 1 FROM article_states WHERE feed_id = ? LIMIT 1');

// The single fetch chain shared by every path: fetch upstream → persist all items into
// article_states (the durable store the list endpoints read from) → stamp the feed's
// last_fetched_at. On-demand reads, background refresh, startup warming and the poller all
// route through here, so every successful fetch persists.
export async function refreshFeed(
  feed: Feed,
  signal?: AbortSignal,
): Promise<{ items: RssItem[]; feedName: string }> {
  const parsed = await parseURL(resolveUrl(feed.url), signal);
  const feedName = parsed.title || feed.name;
  db.transaction(() => {
    persistItems(feed, parsed.items, feedName);
    setFetchedAt.run(Date.now(), feed.id);
  })();
  return { items: parsed.items, feedName };
}

// Ensure a feed's data is reasonably fresh before its rows are served. Callers read articles
// straight from article_states afterward — this only schedules upstream fetches:
//   - fresh (fetched within TTL): no-op
//   - stale but previously fetched: refresh in the background, serve current rows
//   - never fetched and no rows yet (brand-new feed): await so the first load returns content
//   - never fetched but rows exist (e.g. right after the feed_cache→pub_ts migration):
//     treat as stale, refresh in the background
export async function ensureFresh(feed: Feed, signal?: AbortSignal): Promise<void> {
  const last = feed.last_fetched_at ?? 0;
  if (last && Date.now() - last < CACHE_TTL) return;
  const backgroundRefresh = () =>
    refreshFeed(feed).catch((err) =>
      log.debug('background refresh failed', { feedId: feed.id, feedUrl: feed.url, err }),
    );
  if (last) {
    backgroundRefresh();
    return;
  }
  if (feedHasRows.get(feed.id)) {
    backgroundRefresh();
  } else {
    await refreshFeed(feed, signal);
  }
}

export let cacheReady = false;

// Warm feeds on startup. Skipped in TEST_DB mode to avoid real network calls. Feeds never
// fetched are warmed up front (and gate cacheReady); already-fetched-but-stale feeds refresh
// in the background.
export function startCacheWarming(): void {
  if (process.env.TEST_DB) return;
  const allFeeds = db.prepare('SELECT * FROM feeds').all() as Feed[];
  const warm = (f: Feed) =>
    refreshFeed(f).catch((err) =>
      log.warn('cache warm failed', { feedId: f.id, feedUrl: f.url, err }),
    );
  // Re-fetch stale (previously fetched) entries in the background.
  allFeeds
    .filter((f) => f.last_fetched_at && Date.now() - f.last_fetched_at >= CACHE_TTL)
    .forEach(warm);
  const uncached = allFeeds.filter((f) => !f.last_fetched_at);
  if (uncached.length === 0) {
    cacheReady = true;
  } else {
    Promise.allSettled(uncached.map(warm)).then(() => {
      cacheReady = true;
      log.info('cache warmed', { feeds: uncached.length });
    });
  }
}
