import { refreshFeed } from './cache.ts';
import { db } from './db.ts';
import { logger } from './logger.ts';
import { runMaintenance } from './maintenance.ts';
import type { Feed } from './types.ts';

const log = logger.child({ mod: 'poller' });
const POLL_INTERVAL = 15 * 60 * 1000;
const MAINTENANCE_INTERVAL = 24 * 60 * 60 * 1000;

async function pollFeed(feed: Feed): Promise<void> {
  try {
    await refreshFeed(feed);
  } catch (err) {
    log.warn('feed poll failed', { feedId: feed.id, feedUrl: feed.url, err });
  }
}

async function pollAllFeeds(): Promise<void> {
  const feeds = db.prepare('SELECT * FROM feeds').all() as Feed[];
  for (let i = 0; i < feeds.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
    await pollFeed(feeds[i]);
  }
}

export function startPoller(): void {
  if (process.env.TEST_DB) return;
  runMaintenance();
  setInterval(runMaintenance, MAINTENANCE_INTERVAL);
  setTimeout(async () => {
    await pollAllFeeds();
    setInterval(pollAllFeeds, POLL_INTERVAL);
  }, 5000);
}
