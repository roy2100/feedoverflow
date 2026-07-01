import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import request from 'supertest';

process.env.TEST_DB = ':memory:';

const { app } = await import('../app.ts');
const { db } = await import('../db.ts');

describe('feeds CRUD', () => {
  test('POST /api/feeds without a url returns 400', async () => {
    const res = await request(app).post('/api/feeds').send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'URL required');
  });

  test('POST /api/feeds rejects a url that already exists with 409', async () => {
    db.prepare('INSERT INTO feeds (id,name,url) VALUES (?,?,?)').run(
      'dup-1',
      'Existing',
      'https://example.com/dup',
    );
    const res = await request(app).post('/api/feeds').send({ url: 'https://example.com/dup' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, '该 Feed 已存在');
    // No second row was created (and no network parse was attempted).
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM feeds WHERE url = ?')
      .get('https://example.com/dup') as { n: number };
    assert.equal(n.n, 1);
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

  test('DELETE /api/feeds/:id purges non-starred articles but keeps starred ones', async () => {
    db.prepare('INSERT INTO feeds (id,name,url) VALUES (?,?,?)').run(
      'del-2',
      'Purge Me',
      'https://example.com/del2',
    );
    const ins = db.prepare(
      'INSERT INTO article_states (article_id,feed_id,feed_name,title,link,is_starred) VALUES (?,?,?,?,?,?)',
    );
    ins.run('a-plain', 'del-2', 'Purge Me', 'Plain', 'https://example.com/del2/1', 0);
    ins.run('a-starred', 'del-2', 'Purge Me', 'Starred', 'https://example.com/del2/2', 1);

    const res = await request(app).delete('/api/feeds/del-2');
    assert.equal(res.status, 200);
    assert.equal(db.prepare('SELECT 1 FROM feeds WHERE id = ?').get('del-2'), undefined);
    assert.equal(
      db.prepare('SELECT 1 FROM article_states WHERE article_id = ?').get('a-plain'),
      undefined,
      'non-starred article must be purged',
    );
    assert.ok(
      db.prepare('SELECT 1 FROM article_states WHERE article_id = ?').get('a-starred'),
      'starred article must survive feed deletion',
    );
    // This suite shares one in-memory DB; drop the surviving starred row so it doesn't
    // inflate the later /starred/count assertions.
    db.prepare('DELETE FROM article_states WHERE article_id = ?').run('a-starred');
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

describe('podcasts list', () => {
  test('GET /api/podcasts lists only articles with an audio_url, newest first', async () => {
    const ins = db.prepare(`
      INSERT OR IGNORE INTO article_states
        (article_id,feed_id,feed_name,title,link,pub_date,summary,content,author,audio_url,audio_duration,is_starred)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0)
    `);
    ins.run(
      'pod-old',
      'f-pod',
      'Pod Feed',
      'Old Episode',
      'https://ex.com/old',
      'Mon, 01 Jan 2024 00:00:00 GMT',
      's',
      '',
      'host',
      'https://ex.com/old.mp3',
      '12:00',
    );
    ins.run(
      'pod-new',
      'f-pod',
      'Pod Feed',
      'New Episode',
      'https://ex.com/new',
      'Wed, 01 Jan 2025 00:00:00 GMT',
      's',
      '',
      'host',
      'https://ex.com/new.mp3',
      '34:00',
    );
    ins.run(
      'not-pod',
      'f-pod',
      'Pod Feed',
      'Text Post',
      'https://ex.com/text',
      'Thu, 01 Jan 2026 00:00:00 GMT',
      's',
      '',
      'author',
      null,
      null,
    );

    const res = await request(app).get('/api/podcasts');
    assert.equal(res.status, 200);
    const ids = res.body.articles.map((a: { id: string }) => a.id);
    assert.ok(ids.includes('pod-new'));
    assert.ok(ids.includes('pod-old'));
    assert.ok(!ids.includes('not-pod'), 'non-audio article must be excluded');
    // Newest by parsed pub_date first
    assert.ok(ids.indexOf('pod-new') < ids.indexOf('pod-old'));
    assert.equal(res.body.articles[ids.indexOf('pod-new')].audioUrl, 'https://ex.com/new.mp3');
  });
});

describe('search input guard', () => {
  test('queries shorter than 2 chars short-circuit to an empty list', async () => {
    const res = await request(app).get('/api/search?q=a');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { articles: [], query: 'a' });
  });
});
