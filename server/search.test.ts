import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';

// Isolate every test run in its own temp DB so tests are repeatable.
const TEST_DB_PATH = join(tmpdir(), `rss-search-test-${process.pid}.db`);
process.env.TEST_DB = TEST_DB_PATH;

const { app } = await import('./app.ts');
const { db } = await import('./db.ts');
const { persistItems } = await import('./articles.ts');

let server: Server;
let baseUrl: string;

before(async () => {
  // /api/search reads only from article_states (no live fetch), so the seeded default
  // feeds are irrelevant; drop them to keep the test DB minimal.
  db.prepare('DELETE FROM feeds').run();

  const feed = { id: 'f1', name: 'Test Feed', url: 'https://example.com/feed' };
  const items = [
    {
      title: 'Zebra crossing the road',
      link: 'https://example.com/1',
      pubDate: new Date(Date.now() - 1000).toISOString(),
      contentSnippet: 'plain summary one',
      contentEncoded: '<p>plain body one</p>',
      creator: 'A',
    },
    {
      title: 'plain title two',
      link: 'https://example.com/2',
      pubDate: new Date(Date.now() - 2000).toISOString(),
      contentSnippet: 'a Quokka appears here',
      contentEncoded: '<p>plain body two</p>',
      creator: 'A',
    },
    {
      title: 'plain title three',
      link: 'https://example.com/3',
      pubDate: new Date(Date.now() - 3000).toISOString(),
      contentSnippet: 'plain summary three',
      contentEncoded: '<p>a Narwhal swims in the body</p>',
      creator: 'A',
    },
  ];
  persistItems(feed, items, 'Test Feed');

  // A second feed sharing the keyword "plain", to verify feed-scoped search excludes it.
  const feed2 = { id: 'f2', name: 'Other Feed', url: 'https://other.com/feed' };
  persistItems(
    feed2,
    [
      {
        title: 'plain title in other feed',
        link: 'https://other.com/1',
        pubDate: new Date(Date.now() - 500).toISOString(),
        contentSnippet: 'plain summary other',
        contentEncoded: '<p>plain body other</p>',
        creator: 'B',
      },
    ],
    'Other Feed',
  );

  // Star one f1 article so scope=starred can be verified.
  db.prepare('UPDATE article_states SET is_starred = 1 WHERE link = ?').run(
    'https://example.com/1',
  );

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

async function search(q: string, scope?: string) {
  const res = await fetch(
    `${baseUrl}/api/search?q=${encodeURIComponent(q)}${scope ? `&${scope}` : ''}`,
  );
  return (await res.json()) as {
    articles: Array<{ title: string; feedId: string; isStarred: boolean }>;
    query: string;
  };
}

test('matches on title', async () => {
  const { articles } = await search('Zebra');
  assert.equal(articles.length, 1);
  assert.match(articles[0].title, /Zebra/);
});

test('matches on summary', async () => {
  const { articles } = await search('Quokka');
  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, 'plain title two');
});

test('matches on body content', async () => {
  const { articles } = await search('Narwhal');
  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, 'plain title three');
});

test('is case-insensitive', async () => {
  const { articles } = await search('zEbRa');
  assert.equal(articles.length, 1);
});

test('query shorter than 2 chars returns empty', async () => {
  const { articles } = await search('Z');
  assert.equal(articles.length, 0);
});

test('no match returns empty list', async () => {
  const { articles } = await search('Platypus');
  assert.equal(articles.length, 0);
});

test('global "plain" matches across both feeds', async () => {
  const { articles } = await search('plain');
  // 3 f1 titles/summaries/bodies + 1 f2 = 4
  assert.equal(articles.length, 4);
});

test('scope=feed restricts to one feed', async () => {
  const { articles } = await search('plain', 'scope=feed&feedId=f2');
  assert.equal(articles.length, 1);
  assert.equal(articles[0].feedId, 'f2');
});

test('scope=starred restricts to starred articles', async () => {
  const { articles } = await search('plain', 'scope=starred');
  assert.equal(articles.length, 1);
  assert.equal(articles[0].isStarred, true);
  assert.match(articles[0].title, /Zebra/);
});

test('unknown scope falls back to global', async () => {
  const { articles } = await search('plain', 'scope=bogus');
  assert.equal(articles.length, 4);
});
