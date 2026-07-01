import { refreshFeed } from './cache.ts';
import { db } from './db.ts';
import { logger } from './logger.ts';
import { checkpointWal, runMaintenance } from './maintenance.ts';
import type { Feed } from './types.ts';

const log = logger.child({ mod: 'poller' });
const POLL_INTERVAL = 15 * 60 * 1000;
const MAINTENANCE_INTERVAL = 24 * 60 * 60 * 1000;
// Reclaim the WAL far more often than the 15-min poll / 24-h maintenance passes so it stays
// small between the write bursts those (and on-demand refreshes) produce. See checkpointWal().
const CHECKPOINT_INTERVAL = 5 * 60 * 1000;

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
  checkpointWal();
  setInterval(checkpointWal, CHECKPOINT_INTERVAL);
  setTimeout(async () => {
    await pollAllFeeds();
    setInterval(pollAllFeeds, POLL_INTERVAL);
  }, 5000);
}
