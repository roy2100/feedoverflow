import { db } from './db.ts';
import { parseURL } from './parse-url.ts';
import { resolveUrl } from './articles.ts';
import type { Feed, FeedCacheRow } from './types.ts';
import type { RssItem } from './parse-url.ts';

export const CACHE_TTL = 5 * 60 * 1000;

const getCacheRow = db.prepare('SELECT * FROM feed_cache WHERE feed_id = ?');
const setCacheRow = db.prepare(
  'INSERT OR REPLACE INTO feed_cache (feed_id, feed_name, items_json, fetched_at) VALUES (?, ?, ?, ?)'
);
export const clearCache = db.prepare('DELETE FROM feed_cache');

export async function fetchAndCache(feed: Feed): Promise<{ items: RssItem[]; feedName: string }> {
  const parsed = await parseURL(resolveUrl(feed.url));
  setCacheRow.run(feed.id, parsed.title || feed.name, JSON.stringify(parsed.items), Date.now());
  return { items: parsed.items, feedName: parsed.title || feed.name };
}

export async function getCachedFeed(feed: Feed, signal?: AbortSignal): Promise<{ items: RssItem[]; feedName: string } | null> {
  const row = getCacheRow.get(feed.id) as FeedCacheRow | undefined;
  if (!row) {
    const parsed = await parseURL(resolveUrl(feed.url), signal);
    if (signal?.aborted) return null;
    setCacheRow.run(feed.id, parsed.title || feed.name, JSON.stringify(parsed.items), Date.now());
    return { items: parsed.items, feedName: parsed.title || feed.name };
  }
  if (Date.now() - row.fetched_at >= CACHE_TTL) fetchAndCache(feed).catch(() => {});
  return { items: JSON.parse(row.items_json) as RssItem[], feedName: row.feed_name };
}

export let cacheReady = false;

// Warm cache on startup. Skipped in TEST_DB mode to avoid real network calls.
export function startCacheWarming(): void {
  if (process.env.TEST_DB) return;
  const allFeeds = db.prepare('SELECT * FROM feeds').all() as Feed[];
  // Re-fetch stale entries in background
  allFeeds
    .filter(f => {
      const r = getCacheRow.get(f.id) as FeedCacheRow | undefined;
      return r && Date.now() - r.fetched_at >= CACHE_TTL;
    })
    .forEach(f => fetchAndCache(f).catch(() => {}));
  const uncached = allFeeds.filter(f => !getCacheRow.get(f.id));
  if (uncached.length === 0) {
    cacheReady = true;
  } else {
    Promise.allSettled(uncached.map(f => fetchAndCache(f).catch(() => {})))
      .then(() => { cacheReady = true; });
  }
}
