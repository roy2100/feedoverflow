import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';

// Isolate every test run in its own temp DB so tests are repeatable.
const TEST_DB_PATH = join(tmpdir(), `rss-poller-test-${process.pid}.db`);
process.env.TEST_DB = TEST_DB_PATH;

const { db } = await import('../db.ts');
const { persistItems, makeId } = await import('../articles.ts');

// ── Helpers ───────────────────────────────────────────────────────────────────

after(() => {
  db.close();
  try {
    unlinkSync(TEST_DB_PATH);
  } catch {}
});

function makeFakeItems(n: number, feedId = 'f1') {
  return Array.from({ length: n }, (_, i) => ({
    title: `Article ${i}`,
    link: `https://example.com/${feedId}/${i}`,
    pubDate: new Date(Date.now() - i * 1000).toISOString(),
    contentSnippet: `Summary ${i}`,
    contentEncoded: `<p>Content ${i}</p>`,
    creator: 'Author',
  }));
}

// ── persistItems ──────────────────────────────────────────────────────────────

test('persistItems — writes new articles with their content', () => {
  const feed = { id: 'f3', name: 'Feed 3', url: 'https://example.com/f3' };
  const items = makeFakeItems(2, 'f3');
  persistItems(feed, items, 'Feed 3');

  const rows = db
    .prepare('SELECT content, is_starred FROM article_states WHERE feed_id = ?')
    .all('f3') as Array<{ content: string; is_starred: number }>;
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every((r) => r.content === '<p>Content 0</p>' || r.content === '<p>Content 1</p>'),
    'content should be persisted',
  );
  assert.ok(
    rows.every((r) => r.is_starred === 0),
    'new articles are not starred',
  );
});

test('persistItems INSERT OR IGNORE — repeat persists do not overwrite existing state', () => {
  const feed = { id: 'f5', name: 'Feed 5', url: 'https://example.com/f5' };
  const items = makeFakeItems(1, 'f5');
  const articleId = makeId(items[0].link, items[0].title, items[0].pubDate);

  persistItems(feed, items, 'Feed 5');
  db.prepare('UPDATE article_states SET is_starred = 1 WHERE article_id = ?').run(articleId);
  persistItems(feed, items, 'Feed 5');

  const row = db
    .prepare('SELECT is_starred FROM article_states WHERE article_id = ?')
    .get(articleId) as { is_starred: number };
  assert.equal(row.is_starred, 1, 'user starred state must not be overwritten by a re-persist');
});

test('persistItems — persists all items with no 50-item cap', () => {
  const feed = { id: 'f6', name: 'Feed 6', url: 'https://example.com/f6' };
  const items = makeFakeItems(60, 'f6');
  persistItems(feed, items, 'Feed 6');

  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM article_states WHERE feed_id = ?')
    .get('f6') as { n: number };
  assert.equal(n, 60);
});
