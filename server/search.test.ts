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
  // Drop the seeded default feeds so /api/search's live-cache loop makes no
  // network calls — this suite only exercises the persisted (article_states) path.
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

async function search(q: string) {
  const res = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(q)}`);
  return (await res.json()) as { articles: Array<{ title: string }>; query: string };
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
