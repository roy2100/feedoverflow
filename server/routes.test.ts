import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import request from 'supertest';

process.env.TEST_DB = ':memory:';

const { app } = await import('./app.ts');
const { db } = await import('./db.ts');

describe('feeds CRUD', () => {
  test('POST /api/feeds without a url returns 400', async () => {
    const res = await request(app).post('/api/feeds').send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'URL required');
  });

  test('PATCH /api/feeds/:id renames an existing feed', async () => {
    db.prepare('INSERT INTO feeds (id,name,url) VALUES (?,?,?)').run(
      'patch-1',
      'Old Name',
      'https://example.com/patch',
    );
    const res = await request(app).patch('/api/feeds/patch-1').send({ name: 'New Name' });
    assert.equal(res.status, 200);
    const row = db.prepare('SELECT name FROM feeds WHERE id = ?').get('patch-1') as {
      name: string;
    };
    assert.equal(row.name, 'New Name');
  });

  test('PATCH /api/feeds/:id on a missing feed returns 404', async () => {
    const res = await request(app).patch('/api/feeds/nope').send({ name: 'x' });
    assert.equal(res.status, 404);
  });

  test('DELETE /api/feeds/:id removes an existing feed', async () => {
    db.prepare('INSERT INTO feeds (id,name,url) VALUES (?,?,?)').run(
      'del-1',
      'Doomed',
      'https://example.com/del',
    );
    const res = await request(app).delete('/api/feeds/del-1');
    assert.equal(res.status, 200);
    assert.equal(db.prepare('SELECT 1 FROM feeds WHERE id = ?').get('del-1'), undefined);
  });

  test('DELETE /api/feeds/:id on a missing feed returns 404', async () => {
    const res = await request(app).delete('/api/feeds/nope');
    assert.equal(res.status, 404);
  });
});

describe('OPML import', () => {
  test('POST /api/feeds/import-opml without content returns 400', async () => {
    const res = await request(app).post('/api/feeds/import-opml').send({});
    assert.equal(res.status, 400);
  });

  test('imports new feeds (including nested outlines) and skips existing urls', async () => {
    db.prepare('INSERT INTO feeds (id,name,url) VALUES (?,?,?)').run(
      'existing',
      'Existing',
      'https://dup.example.com/feed',
    );
    const opml = `<?xml version="1.0"?>
      <opml version="1.0"><body>
        <outline text="Tech">
          <outline text="Nested Feed" xmlUrl="https://new.example.com/a" />
        </outline>
        <outline text="Top Feed" xmlUrl="https://new.example.com/b" />
        <outline text="Dup" xmlUrl="https://dup.example.com/feed" />
      </body></opml>`;
    const res = await request(app).post('/api/feeds/import-opml').send({ opml });
    assert.equal(res.status, 200);
    assert.equal(res.body.imported, 2);
    assert.equal(res.body.skipped, 1);
    const urls = (db.prepare('SELECT url FROM feeds').all() as Array<{ url: string }>).map(
      (r) => r.url,
    );
    assert.ok(urls.includes('https://new.example.com/a'));
    assert.ok(urls.includes('https://new.example.com/b'));
  });

  test('malformed OPML returns 400', async () => {
    const res = await request(app)
      .post('/api/feeds/import-opml')
      .send({ opml: '<opml><body><outline' });
    assert.equal(res.status, 400);
  });
});

describe('settings', () => {
  test('GET /api/settings returns the seeded rsshub_base_url', async () => {
    const res = await request(app).get('/api/settings');
    assert.equal(res.status, 200);
    assert.equal(res.body.rsshub_base_url, 'http://localhost:1200');
  });

  test('PATCH /api/settings updates only allowed keys (trimmed)', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .send({ rsshub_base_url: '  http://rsshub.test  ', ignored: 'x' });
    assert.equal(res.status, 200);
    const after = await request(app).get('/api/settings');
    assert.equal(after.body.rsshub_base_url, 'http://rsshub.test');
    assert.equal(after.body.ignored, undefined);
  });
});

describe('star + starred lists', () => {
  const article = {
    id: 'star-article-1',
    feedId: 'f-star',
    feedName: 'Star Feed',
    title: 'A Starred Article',
    summary: 'summary',
    content: '<p>body</p>',
    link: 'https://example.com/star-1',
    pubDate: new Date().toISOString(),
    author: 'me',
    audioUrl: '',
    audioDuration: '',
    isStarred: false,
  };

  test('POST /api/articles/star without an id returns 400', async () => {
    const res = await request(app).post('/api/articles/star').send({ article: {}, starred: true });
    assert.equal(res.status, 400);
  });

  test('starring persists the article and surfaces it in /starred + /starred/count', async () => {
    const res = await request(app).post('/api/articles/star').send({ article, starred: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.isStarred, true);

    const list = await request(app).get('/api/starred');
    const ids = list.body.articles.map((a: { id: string }) => a.id);
    assert.ok(ids.includes('star-article-1'));

    const count = await request(app).get('/api/starred/count');
    assert.equal(count.body.count, 1);
  });

  test('GET /api/articles/:id/content returns the persisted body', async () => {
    const res = await request(app).get('/api/articles/star-article-1/content');
    assert.equal(res.status, 200);
    assert.equal(res.body.content, '<p>body</p>');
  });

  test('unstarring drops the count back to zero', async () => {
    await request(app).post('/api/articles/star').send({ article, starred: false }).expect(200);
    const count = await request(app).get('/api/starred/count');
    assert.equal(count.body.count, 0);
  });
});

describe('current-article (in-memory)', () => {
  test('GET returns 404 before anything is opened', async () => {
    const res = await request(app).get('/api/current-article');
    assert.equal(res.status, 404);
  });

  test('POST sets, GET returns, POST with empty body clears it', async () => {
    const article = { id: 'cur-1', title: 'Open Now' };
    await request(app).post('/api/current-article').send({ article }).expect(200);

    const got = await request(app).get('/api/current-article');
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, article);

    await request(app).post('/api/current-article').send({}).expect(200);
    const cleared = await request(app).get('/api/current-article');
    assert.equal(cleared.status, 404);
  });
});

describe('search input guard', () => {
  test('queries shorter than 2 chars short-circuit to an empty list', async () => {
    const res = await request(app).get('/api/search?q=a');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { articles: [], query: 'a' });
  });
});
