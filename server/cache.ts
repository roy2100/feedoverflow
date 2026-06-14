import { persistItems, resolveUrl } from './articles.ts';
import { db } from './db.ts';
import { logger } from './logger.ts';
import { parseURL } from './parse-url.ts';
import type { RssItem } from './parse-url.ts';
import type { Feed, FeedCacheRow } from './types.ts';

const log = logger.child({ mod: 'cache' });

export const CACHE_TTL = 5 * 60 * 1000;

const getCacheRow = db.prepare('SELECT * FROM feed_cache WHERE feed_id = ?');
const setCacheRow = db.prepare(
  'INSERT OR REPLACE INTO feed_cache (feed_id, feed_name, items_json, fetched_at) VALUES (?, ?, ?, ?)',
);
export const clearCache = db.prepare('DELETE FROM feed_cache');

// The single fetch chain shared by every path: fetch upstream → write the feed_cache row →
// persist all items into article_states. On-demand cold misses, background refresh, startup
// warming and the poller all route through here, so every successful fetch persists.
export async function refreshFeed(
  feed: Feed,
  signal?: AbortSignal,
): Promise<{ items: RssItem[]; feedName: string }> {
  const parsed = await parseURL(resolveUrl(feed.url), signal);
  const feedName = parsed.title || feed.name;
  setCacheRow.run(feed.id, feedName, JSON.stringify(parsed.items), Date.now());
  persistItems(feed, parsed.items, feedName);
  return { items: parsed.items, feedName };
}

export async function getCachedFeed(
  feed: Feed,
  signal?: AbortSignal,
): Promise<{ items: RssItem[]; feedName: string } | null> {
  const row = getCacheRow.get(feed.id) as FeedCacheRow | undefined;
  if (!row) {
    const result = await refreshFeed(feed, signal);
    return signal?.aborted ? null : result;
  }
  if (Date.now() - row.fetched_at >= CACHE_TTL) {
    refreshFeed(feed).catch((err) =>
      log.debug('background refresh failed', { feedId: feed.id, feedUrl: feed.url, err }),
    );
  }
  return { items: JSON.parse(row.items_json) as RssItem[], feedName: row.feed_name };
}

export let cacheReady = false;

// Warm cache on startup. Skipped in TEST_DB mode to avoid real network calls.
export function startCacheWarming(): void {
  if (process.env.TEST_DB) return;
  const allFeeds = db.prepare('SELECT * FROM feeds').all() as Feed[];
  const warm = (f: Feed) =>
    refreshFeed(f).catch((err) =>
      log.warn('cache warm failed', { feedId: f.id, feedUrl: f.url, err }),
    );
  // Re-fetch stale entries in background
  allFeeds
    .filter((f) => {
      const r = getCacheRow.get(f.id) as FeedCacheRow | undefined;
      return r && Date.now() - r.fetched_at >= CACHE_TTL;
    })
    .forEach(warm);
  const uncached = allFeeds.filter((f) => !getCacheRow.get(f.id));
  if (uncached.length === 0) {
    cacheReady = true;
  } else {
    Promise.allSettled(uncached.map(warm)).then(() => {
      cacheReady = true;
      log.info('cache warmed', { feeds: uncached.length });
    });
  }
}
