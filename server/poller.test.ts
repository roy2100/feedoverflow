import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';

// Isolate every test run in its own temp DB so tests are repeatable.
const TEST_DB_PATH = join(tmpdir(), `rss-poller-test-${process.pid}.db`);
process.env.TEST_DB = TEST_DB_PATH;

const { app } = await import('./app.ts');
const { db } = await import('./db.ts');
const { persistPolled } = await import('./poller.ts');
const { makeId } = await import('./articles.ts');

// ── Helpers ───────────────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

before(async () => {
  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  try {
    unlinkSync(TEST_DB_PATH);
  } catch {}
});

async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

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

const FAKE_FEED = { id: 'f1', name: 'Test Feed', url: 'https://example.com/feed' };

// ── /api/unread-counts ────────────────────────────────────────────────────────

test('/api/unread-counts — empty DB returns an empty object', async () => {
  const { status, body } = await get('/api/unread-counts');
  assert.equal(status, 200);
  assert.deepEqual(body, {});
});

test('/api/unread-counts — returns the unread count per feed', async () => {
  const items = makeFakeItems(3);
  persistPolled(FAKE_FEED, items, 'Test Feed', { markRead: false });

  const { body } = await get('/api/unread-counts');
  assert.equal((body as Record<string, number>)['f1'], 3);
});

test('/api/unread-counts — count drops after marking an article read', async () => {
  const items = makeFakeItems(1, 'f2');
  const feed2 = { id: 'f2', name: 'Feed 2', url: 'https://example.com/feed2' };
  persistPolled(feed2, items, 'Feed 2', { markRead: false });

  const articleId = makeId(items[0].link, items[0].title, items[0].pubDate);
  await post('/api/articles/read', {
    article: {
      id: articleId,
      feedId: 'f2',
      feedName: 'Feed 2',
      title: items[0].title,
      link: items[0].link,
      pubDate: items[0].pubDate,
      summary: '',
      content: '',
      author: '',
    },
  });

  const { body } = await get('/api/unread-counts');
  assert.equal((body as Record<string, number>)['f2'] ?? 0, 0);
});

// ── persistPolled ─────────────────────────────────────────────────────────────

test('persistPolled markRead:false — new articles are written with is_read=0', () => {
  const feed = { id: 'f3', name: 'Feed 3', url: 'https://example.com/f3' };
  const items = makeFakeItems(2, 'f3');
  persistPolled(feed, items, 'Feed 3', { markRead: false });

  const rows = db
    .prepare('SELECT is_read FROM article_states WHERE feed_id = ?')
    .all('f3') as Array<{ is_read: number }>;
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every((r) => r.is_read === 0),
    'all articles should be unread',
  );
});

test('persistPolled markRead:true — baseline first write sets is_read=1', () => {
  const feed = { id: 'f4', name: 'Feed 4', url: 'https://example.com/f4' };
  const items = makeFakeItems(2, 'f4');
  persistPolled(feed, items, 'Feed 4', { markRead: true });

  const rows = db
    .prepare('SELECT is_read FROM article_states WHERE feed_id = ?')
    .all('f4') as Array<{ is_read: number }>;
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every((r) => r.is_read === 1),
    'baseline articles should all be marked read',
  );
});

test('persistPolled INSERT OR IGNORE — repeat polls do not overwrite existing state', () => {
  const feed = { id: 'f5', name: 'Feed 5', url: 'https://example.com/f5' };
  const items = makeFakeItems(1, 'f5');
  const articleId = makeId(items[0].link, items[0].title, items[0].pubDate);

  persistPolled(feed, items, 'Feed 5', { markRead: false });
  db.prepare('UPDATE article_states SET is_read = 1 WHERE article_id = ?').run(articleId);
  persistPolled(feed, items, 'Feed 5', { markRead: false });

  const row = db
    .prepare('SELECT is_read FROM article_states WHERE article_id = ?')
    .get(articleId) as { is_read: number };
  assert.equal(row.is_read, 1, 'user read state must not be overwritten by poller');
});

test('persistPolled — keeps only the first 50 when given more than 50', () => {
  const feed = { id: 'f6', name: 'Feed 6', url: 'https://example.com/f6' };
  const items = makeFakeItems(60, 'f6');
  persistPolled(feed, items, 'Feed 6', { markRead: false });

  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM article_states WHERE feed_id = ?')
    .get('f6') as { n: number };
  assert.equal(n, 50);
});
