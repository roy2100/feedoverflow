import { parsePubDate } from './articles.ts';
import { DB_MAX_SIZE_BYTES } from './config.ts';
import { db } from './db.ts';
import { logger } from './logger.ts';

const log = logger.child({ mod: 'maintenance' });

// Trim down to this fraction of the cap so we don't re-trigger on the next poll.
const LOW_WATERMARK = 0.9;
// SQLite caps bound parameters (~999); delete ids in chunks below that.
const DELETE_CHUNK = 500;

// Logical DB size on disk = pages * page size. Excludes the -wal/-shm sidecars; after a
// VACUUM the main file tracks this closely.
function dbSizeBytes(): number {
  const pageCount = db.pragma('page_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  return pageCount * pageSize;
}

const deleteOrphans = db.prepare(
  `DELETE FROM article_states
   WHERE is_starred = 0 AND feed_id NOT IN (SELECT id FROM feeds)`,
);

// Delete non-starred rows whose feed no longer exists. Starred rows are kept on purpose
// so a starred article survives removal of its feed (see CLAUDE.md). Returns rows deleted.
export function cleanupOrphans(): number {
  const { changes } = deleteOrphans.run();
  if (changes > 0) log.info('orphan articles removed', { deleted: changes });
  return changes;
}

// pub_date is an RFC-822 string ("Tue, 26 May 2026 10:59:16 +0800") and may be empty, so
// it cannot be sorted as text. Parse it to epoch ms via the shared parser (handles the
// non-standard formats some feeds emit); fall back to updated_at, then 0.
function articleTs(row: { pub_date: string | null; updated_at: string | null }): number {
  const fromPub = parsePubDate(row.pub_date)?.getTime();
  if (fromPub !== undefined) return fromPub;
  const fromUpdated = row.updated_at ? Date.parse(row.updated_at) : NaN;
  return Number.isNaN(fromUpdated) ? 0 : fromUpdated;
}

interface Candidate {
  article_id: string;
  pub_date: string | null;
  updated_at: string | null;
  bytes: number;
}

// If the DB exceeds capBytes, delete the oldest non-starred articles until the logical
// size is back under LOW_WATERMARK * capBytes, then VACUUM to return space to the OS.
// Starred articles are never deleted. Returns rows deleted.
export function enforceSizeCap(capBytes: number = DB_MAX_SIZE_BYTES): number {
  const sizeBefore = dbSizeBytes();
  if (sizeBefore <= capBytes) return 0;

  const target = capBytes * LOW_WATERMARK;
  const needFree = sizeBefore - target;

  // Candidate rows oldest-first. Logical content+summary bytes under-estimate the page
  // bytes a row occupies, so accumulating to needFree errs toward freeing a bit extra.
  const rows = db
    .prepare(
      `SELECT article_id, pub_date, updated_at, LENGTH(content) + LENGTH(summary) AS bytes
       FROM article_states WHERE is_starred = 0`,
    )
    .all() as Candidate[];
  rows.sort((a, b) => articleTs(a) - articleTs(b));

  const toDelete: string[] = [];
  let freed = 0;
  for (const r of rows) {
    toDelete.push(r.article_id);
    freed += r.bytes ?? 0;
    if (freed >= needFree) break;
  }
  if (toDelete.length === 0) return 0;

  const delChunk = db.prepare(
    `DELETE FROM article_states WHERE article_id IN (${'?,'.repeat(DELETE_CHUNK - 1)}?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < toDelete.length; i += DELETE_CHUNK) {
      const chunk = toDelete.slice(i, i + DELETE_CHUNK);
      if (chunk.length === DELETE_CHUNK) {
        delChunk.run(...chunk);
      } else {
        db.prepare(
          `DELETE FROM article_states WHERE article_id IN (${'?,'.repeat(chunk.length - 1)}?)`,
        ).run(...chunk);
      }
    }
  })();

  db.exec('VACUUM');
  const sizeAfter = dbSizeBytes();
  log.info('size cap enforced', {
    capMB: Math.round(capBytes / 1048576),
    beforeMB: Math.round(sizeBefore / 1048576),
    afterMB: Math.round(sizeAfter / 1048576),
    deleted: toDelete.length,
  });
  if (sizeAfter > capBytes) {
    log.warn('still over cap after trimming all non-starred articles', {
      afterMB: Math.round(sizeAfter / 1048576),
      capMB: Math.round(capBytes / 1048576),
    });
  }
  return toDelete.length;
}

// One maintenance pass: clear non-starred orphans, then enforce the size cap.
export function runMaintenance(capBytes: number = DB_MAX_SIZE_BYTES): void {
  try {
    cleanupOrphans();
    enforceSizeCap(capBytes);
  } catch (err) {
    log.error('maintenance pass failed', { err });
  }
}
