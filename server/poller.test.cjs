'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Isolate every test run in its own temp DB so tests are repeatable.
const TEST_DB_PATH = path.join(os.tmpdir(), `rss-poller-test-${process.pid}.db`);
process.env.TEST_DB = TEST_DB_PATH;

const { app, db, persistPolled, makeId } = require('./index.ts');

// ── Helpers ───────────────────────────────────────────────────────────────────

let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
});

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function makeFakeItems(n, feedId = 'f1') {
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

test('/api/unread-counts — 空库返回空对象', async () => {
  const { status, body } = await get('/api/unread-counts');
  assert.equal(status, 200);
  assert.deepEqual(body, {});
});

test('/api/unread-counts — 返回各 feed 的未读数', async () => {
  const items = makeFakeItems(3);
  persistPolled(FAKE_FEED, items, 'Test Feed', { markRead: false });

  const { body } = await get('/api/unread-counts');
  assert.equal(body['f1'], 3);
});

test('/api/unread-counts — 标记已读后数量减少', async () => {
  // Pick one article and mark it read via the API
  const items = makeFakeItems(1, 'f2');
  const feed2 = { id: 'f2', name: 'Feed 2', url: 'https://example.com/feed2' };
  persistPolled(feed2, items, 'Feed 2', { markRead: false });

  const articleId = makeId(items[0].link, items[0].title, items[0].pubDate);
  await post('/api/articles/read', {
    article: { id: articleId, feedId: 'f2', feedName: 'Feed 2', title: items[0].title, link: items[0].link, pubDate: items[0].pubDate, summary: '', content: '', author: '' },
  });

  const { body } = await get('/api/unread-counts');
  assert.equal(body['f2'] ?? 0, 0);
});

// ── persistPolled ─────────────────────────────────────────────────────────────

test('persistPolled markRead:false — 新文章写入 is_read=0', () => {
  const feed = { id: 'f3', name: 'Feed 3', url: 'https://example.com/f3' };
  const items = makeFakeItems(2, 'f3');
  persistPolled(feed, items, 'Feed 3', { markRead: false });

  const rows = db.prepare('SELECT is_read FROM article_states WHERE feed_id = ?').all('f3');
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.is_read === 0), 'all articles should be unread');
});

test('persistPolled markRead:true — baseline 首次写入 is_read=1', () => {
  const feed = { id: 'f4', name: 'Feed 4', url: 'https://example.com/f4' };
  const items = makeFakeItems(2, 'f4');
  persistPolled(feed, items, 'Feed 4', { markRead: true });

  const rows = db.prepare('SELECT is_read FROM article_states WHERE feed_id = ?').all('f4');
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.is_read === 1), 'baseline articles should all be marked read');
});

test('persistPolled INSERT OR IGNORE — 重复 poll 不覆盖已有状态', () => {
  const feed = { id: 'f5', name: 'Feed 5', url: 'https://example.com/f5' };
  const items = makeFakeItems(1, 'f5');
  const articleId = makeId(items[0].link, items[0].title, items[0].pubDate);

  // First poll: insert as unread
  persistPolled(feed, items, 'Feed 5', { markRead: false });
  // Manually mark read (simulating user action)
  db.prepare('UPDATE article_states SET is_read = 1 WHERE article_id = ?').run(articleId);

  // Second poll: re-insert should not reset is_read back to 0
  persistPolled(feed, items, 'Feed 5', { markRead: false });

  const row = db.prepare('SELECT is_read FROM article_states WHERE article_id = ?').get(articleId);
  assert.equal(row.is_read, 1, 'user read state must not be overwritten by poller');
});

test('persistPolled — 超过 50 条只保留前 50 条', () => {
  const feed = { id: 'f6', name: 'Feed 6', url: 'https://example.com/f6' };
  const items = makeFakeItems(60, 'f6');
  persistPolled(feed, items, 'Feed 6', { markRead: false });

  const count = db.prepare('SELECT COUNT(*) AS n FROM article_states WHERE feed_id = ?').get('f6').n;
  assert.equal(count, 50);
});
