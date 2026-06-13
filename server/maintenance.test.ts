import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';

// Isolate this run in its own temp DB.
const TEST_DB_PATH = join(tmpdir(), `rss-maintenance-test-${process.pid}.db`);
process.env.TEST_DB = TEST_DB_PATH;

const { db } = await import('./db.ts');
const { cleanupOrphans, enforceSizeCap } = await import('./maintenance.ts');

const insert = db.prepare(`
  INSERT OR REPLACE INTO article_states
    (article_id, feed_id, feed_name, title, link, pub_date, summary, content, is_starred)
  VALUES (@id, @feedId, '', '', '', @pubDate, @summary, @content, @starred)
`);

function addArticle(
  id: string,
  feedId: string,
  opts: { starred?: 0 | 1; pubDate?: string; content?: string } = {},
) {
  insert.run({
    id,
    feedId,
    pubDate: opts.pubDate ?? '2026-01-01T00:00:00Z',
    summary: '',
    content: opts.content ?? '',
    starred: opts.starred ?? 0,
  });
}

function dbSize(): number {
  return (
    (db.pragma('page_count', { simple: true }) as number) *
    (db.pragma('page_size', { simple: true }) as number)
  );
}

function reset() {
  db.exec('DELETE FROM article_states; DELETE FROM feeds;');
}

before(() => reset());
after(() => {
  db.close();
  try {
    unlinkSync(TEST_DB_PATH);
  } catch {}
});

// ── cleanupOrphans ──────────────────────────────────────────────────────────────

test('cleanupOrphans — deletes non-starred orphans, keeps starred orphans and articles with a live feed', () => {
  reset();
  db.prepare('INSERT INTO feeds (id,name,url) VALUES (?,?,?)').run('live', 'Live', 'http://x');
  addArticle('a-live', 'live'); // feed exists → keep
  addArticle('a-orphan', 'gone'); // orphan, non-starred → delete
  addArticle('a-orphan-starred', 'gone', { starred: 1 }); // orphan but starred → keep

  const deleted = cleanupOrphans();
  assert.equal(deleted, 1);

  const ids = (
    db.prepare('SELECT article_id FROM article_states').all() as Array<{ article_id: string }>
  )
    .map((r) => r.article_id)
    .sort();
  assert.deepEqual(ids, ['a-live', 'a-orphan-starred']);
});

// ── enforceSizeCap ────────────────────────────────────────────────────────────

test('enforceSizeCap — deletes nothing when under the cap', () => {
  reset();
  addArticle('keep1', 'f', { content: 'x'.repeat(1000) });
  addArticle('keep2', 'f', { content: 'x'.repeat(1000) });

  const deleted = enforceSizeCap(500 * 1024 * 1024); // 500MB cap, tiny db
  assert.equal(deleted, 0);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM article_states').get() as { n: number };
  assert.equal(n, 2);
});

test('enforceSizeCap — when over the cap, deletes oldest-first while keeping starred articles', () => {
  reset();
  // Oldest is starred to prove starred is never deleted even when it is the oldest.
  addArticle('star-oldest', 'f', {
    starred: 1,
    pubDate: '2026-01-01T00:00:00Z',
    content: 'x'.repeat(50000),
  });
  addArticle('old', 'f', { pubDate: '2026-02-01T00:00:00Z', content: 'x'.repeat(50000) }); // b1
  addArticle('mid', 'f', { pubDate: '2026-03-01T00:00:00Z', content: 'x'.repeat(50000) }); // b2
  addArticle('new', 'f', { pubDate: '2026-04-01T00:00:00Z', content: 'x'.repeat(50000) }); // newest, must survive

  // Choose a cap so needFree (= size - 0.9*cap) lands between b1 (50000) and b1+b2
  // (100000): this deletes exactly the two oldest non-starred rows, leaving 'new'.
  const size = dbSize();
  const needFreeTarget = 75000; // 50000 < target < 100000
  const cap = Math.floor((size - needFreeTarget) / 0.9);

  const deleted = enforceSizeCap(cap);
  assert.equal(deleted, 2);

  const ids = (
    db.prepare('SELECT article_id FROM article_states').all() as Array<{ article_id: string }>
  )
    .map((r) => r.article_id)
    .sort();
  assert.deepEqual(
    ids,
    ['new', 'star-oldest'],
    'oldest non-starred deleted; newest + starred kept',
  );
});
