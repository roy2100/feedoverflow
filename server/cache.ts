import { persistItems, resolveUrl } from './articles.ts';
import { db } from './db.ts';
import { logger } from './logger.ts';
import { parseURL } from './parse-url.ts';
import type { RssItem } from './parse-url.ts';
import type { Feed } from './types.ts';

const log = logger.child({ mod: 'cache' });

export const CACHE_TTL = 5 * 60 * 1000;

// Cap how many feed refreshes run their synchronous work (RSS parse + persist transaction)
// concurrently. Node is single-threaded and better-sqlite3 is synchronous, so an unbounded
// fan-out — today/all-articles calling ensureFresh across every feed, or startup warming
// firing Promise.allSettled over all uncached feeds — would land N parse+persist bursts on the
// event loop at once and stall every concurrent request (even a trivial starred/count). A
// small limit bounds the worst-case block to a couple feeds' worth of work.
const REFRESH_CONCURRENCY = 2;

const setFetchedAt = db.prepare('UPDATE feeds SET last_fetched_at = ? WHERE id = ?');
const feedHasRows = db.prepare('SELECT 1 FROM article_states WHERE feed_id = ? LIMIT 1');

type RefreshResult = { items: RssItem[]; feedName: string };

// ── refresh scheduler + single-flight dedup ──────────────────────────────────────────────
// Every fetch path (on-demand ensureFresh, poller, startup warming) funnels through
// refreshFeed, so both guards live here and cover all callers at once:
//   - single-flight: a refresh already running for a feed is shared, so today + all-articles +
//     poller hitting the same stale feed do ONE fetch, not three.
//   - concurrency limit: at most REFRESH_CONCURRENCY refreshes do their synchronous work at a
//     time, so a page-load/startup fan-out can't bunch every feed's persist into one block.
const inflight = new Map<string, Promise<RefreshResult>>();
let activeRefreshes = 0;
const slotWaiters: Array<() => void> = [];

function acquireRefreshSlot(): Promise<void> {
  if (activeRefreshes < REFRESH_CONCURRENCY) {
    activeRefreshes++;
    return Promise.resolve();
  }
  return new Promise((resolve) => slotWaiters.push(resolve));
}

function releaseRefreshSlot(): void {
  const next = slotWaiters.shift();
  if (next)
    next(); // hand the slot straight to the next waiter (count stays constant)
  else activeRefreshes--;
}

// The single fetch chain: fetch upstream → persist all items into article_states (the durable
// store the list endpoints read from) → stamp the feed's last_fetched_at. Both writes run in
// one transaction. Guarded by a concurrency slot so the synchronous parse+persist never bunches
// (see REFRESH_CONCURRENCY). The caller's AbortSignal is intentionally not threaded here: a
// single-flight refresh is shared, so one caller disconnecting must not abort a fetch others
// are awaiting — parseURL enforces a hard 10s timeout regardless.
async function doRefresh(feed: Feed): Promise<RefreshResult> {
  await acquireRefreshSlot();
  try {
    const parsed = await parseURL(resolveUrl(feed.url));
    const feedName = parsed.title || feed.name;
    db.transaction(() => {
      persistItems(feed, parsed.items, feedName);
      setFetchedAt.run(Date.now(), feed.id);
    })();
    return { items: parsed.items, feedName };
  } finally {
    releaseRefreshSlot();
  }
}

// On-demand reads, background refresh, startup warming and the poller all route through here, so
// every successful fetch persists. Single-flight: concurrent callers for the same feed share one
// in-flight refresh (entry cleared on settle).
export function refreshFeed(feed: Feed): Promise<RefreshResult> {
  const existing = inflight.get(feed.id);
  if (existing) return existing;
  const p = doRefresh(feed).finally(() => inflight.delete(feed.id));
  inflight.set(feed.id, p);
  return p;
}

// Ensure a feed's data is reasonably fresh before its rows are served. Callers read articles
// straight from article_states afterward — this only schedules upstream fetches:
//   - fresh (fetched within TTL): no-op
//   - stale but previously fetched: refresh in the background, serve current rows
//   - never fetched and no rows yet (brand-new feed): await so the first load returns content
//   - never fetched but rows exist (e.g. right after the feed_cache→pub_ts migration):
//     treat as stale, refresh in the background
export async function ensureFresh(feed: Feed): Promise<void> {
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
    await refreshFeed(feed);
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
