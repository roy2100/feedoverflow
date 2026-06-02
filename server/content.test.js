'use strict';

// Must be set before requiring server module so it uses an isolated in-memory DB
process.env.TEST_DB = ':memory:';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, db, makeId } = require('./index.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FEED_ID = 'test-feed-1';

const todayISO = new Date().toISOString();

const TEST_ITEMS = [
  {
    title: 'Article With Full Content',
    link: 'https://example.com/article-1',
    pubDate: todayISO,
    isoDate: todayISO,
    contentSnippet: 'Short summary of article one',
    contentEncoded: '<p>Full HTML content here</p>',
    content: '',
  },
  {
    title: 'Article Summary Only',
    link: 'https://example.com/article-2',
    pubDate: todayISO,
    isoDate: todayISO,
    contentSnippet: 'Summary only',
    content: 'Summary only',
    contentEncoded: '',
  },
];

const ARTICLE_1_ID = makeId(TEST_ITEMS[0].link, TEST_ITEMS[0].title, TEST_ITEMS[0].pubDate);
const ARTICLE_2_ID = makeId(TEST_ITEMS[1].link, TEST_ITEMS[1].title, TEST_ITEMS[1].pubDate);

before(() => {
  db.prepare('INSERT OR IGNORE INTO feeds (id, name, url) VALUES (?, ?, ?)').run(
    FEED_ID, 'Test Feed', 'https://example.com/feed.xml'
  );
  db.prepare(
    'INSERT OR REPLACE INTO feed_cache (feed_id, feed_name, items_json, fetched_at) VALUES (?, ?, ?, ?)'
  ).run(FEED_ID, 'Test Feed', JSON.stringify(TEST_ITEMS), Date.now());
});

// ── enrich() strips content in list endpoints ─────────────────────────────────

describe('GET /api/all-articles — content stripped', () => {
  test('content field is empty string for every article', async () => {
    const res = await request(app).get('/api/all-articles');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.articles), 'articles should be an array');
    assert.ok(res.body.articles.length > 0, 'should have at least one article');
    for (const article of res.body.articles) {
      assert.equal(article.content, '', `expected empty content for article "${article.title}"`);
    }
  });

  test('summary field is still present', async () => {
    const res = await request(app).get('/api/all-articles');
    assert.ok(res.body.articles.some(a => a.summary.length > 0), 'at least one article should have summary');
  });
});

describe('GET /api/today — content stripped', () => {
  test('content field is empty string for every article', async () => {
    const res = await request(app).get('/api/today');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.articles));
    for (const article of res.body.articles) {
      assert.equal(article.content, '');
    }
  });
});

describe('GET /api/feeds/:id/articles — content stripped', () => {
  test('content field is empty string', async () => {
    const res = await request(app).get(`/api/feeds/${FEED_ID}/articles`);
    assert.equal(res.status, 200);
    assert.ok(res.body.articles.length > 0);
    for (const article of res.body.articles) {
      assert.equal(article.content, '');
    }
  });
});

// ── GET /api/articles/:id/content ────────────────────────────────────────────

describe('GET /api/articles/:id/content', () => {
  test('returns contentEncoded from feed_cache', async () => {
    const res = await request(app)
      .get(`/api/articles/${ARTICLE_1_ID}/content?feedId=${FEED_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.content, '<p>Full HTML content here</p>');
  });

  test('falls back to item.content when contentEncoded is absent', async () => {
    const res = await request(app)
      .get(`/api/articles/${ARTICLE_2_ID}/content?feedId=${FEED_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.content, 'Summary only');
  });

  test('article_states content takes priority over feed_cache', async () => {
    const SAVED_ID = 'saved-in-states';
    db.prepare(`
      INSERT OR REPLACE INTO article_states
        (article_id, feed_id, feed_name, title, link, pub_date, summary, content, author, is_read, is_starred)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
    `).run(SAVED_ID, FEED_ID, 'Test Feed', 'Saved', 'https://example.com/saved',
      todayISO, '', '<p>Persisted content</p>', '');

    const res = await request(app).get(`/api/articles/${SAVED_ID}/content?feedId=${FEED_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.content, '<p>Persisted content</p>');
  });

  test('returns empty string for unknown article and feed', async () => {
    const res = await request(app).get('/api/articles/no-such-id/content?feedId=no-such-feed');
    assert.equal(res.status, 200);
    assert.equal(res.body.content, '');
  });

  test('returns empty string when feedId query param is omitted', async () => {
    const res = await request(app).get('/api/articles/no-such-id/content');
    assert.equal(res.status, 200);
    assert.equal(res.body.content, '');
  });
});

// ── POST /api/articles/read — persists content via lookupContent ──────────────

describe('POST /api/articles/read', () => {
  test('saves content from feed_cache when article.content is empty', async () => {
    const article = {
      id: ARTICLE_1_ID,
      feedId: FEED_ID,
      feedName: 'Test Feed',
      title: TEST_ITEMS[0].title,
      link: TEST_ITEMS[0].link,
      pubDate: TEST_ITEMS[0].pubDate,
      summary: TEST_ITEMS[0].contentSnippet,
      content: '',
      author: '',
      audioUrl: '',
      audioDuration: '',
    };

    const res = await request(app).post('/api/articles/read').send({ article });
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);

    const saved = db.prepare('SELECT content FROM article_states WHERE article_id = ?').get(ARTICLE_1_ID);
    assert.equal(saved?.content, '<p>Full HTML content here</p>', 'content should be persisted from feed_cache');
  });

  test('marks article as read in article_states', async () => {
    const article = {
      id: ARTICLE_2_ID,
      feedId: FEED_ID,
      feedName: 'Test Feed',
      title: TEST_ITEMS[1].title,
      link: TEST_ITEMS[1].link,
      pubDate: TEST_ITEMS[1].pubDate,
      summary: TEST_ITEMS[1].contentSnippet,
      content: '',
      author: '',
      audioUrl: '',
      audioDuration: '',
    };

    await request(app).post('/api/articles/read').send({ article });
    const saved = db.prepare('SELECT is_read FROM article_states WHERE article_id = ?').get(ARTICLE_2_ID);
    assert.equal(saved?.is_read, 1);
  });
});

// ── POST /api/articles/star — persists content via lookupContent ──────────────

describe('POST /api/articles/star', () => {
  test('saves content from feed_cache when starring with empty content', async () => {
    const article = {
      id: ARTICLE_1_ID,
      feedId: FEED_ID,
      feedName: 'Test Feed',
      title: TEST_ITEMS[0].title,
      link: TEST_ITEMS[0].link,
      pubDate: TEST_ITEMS[0].pubDate,
      summary: TEST_ITEMS[0].contentSnippet,
      content: '',
      author: '',
      audioUrl: '',
      audioDuration: '',
    };

    const res = await request(app).post('/api/articles/star').send({ article, starred: true });
    assert.equal(res.status, 200);
    assert.ok(res.body.isStarred);

    const saved = db.prepare('SELECT content, is_starred FROM article_states WHERE article_id = ?').get(ARTICLE_1_ID);
    assert.equal(saved?.is_starred, 1);
    assert.equal(saved?.content, '<p>Full HTML content here</p>', 'content should be persisted from feed_cache');
  });

  test('unstar sets is_starred to 0', async () => {
    const article = {
      id: ARTICLE_1_ID,
      feedId: FEED_ID,
      feedName: 'Test Feed',
      title: TEST_ITEMS[0].title,
      link: TEST_ITEMS[0].link,
      pubDate: TEST_ITEMS[0].pubDate,
      summary: TEST_ITEMS[0].contentSnippet,
      content: '',
      author: '',
      audioUrl: '',
      audioDuration: '',
    };

    const res = await request(app).post('/api/articles/star').send({ article, starred: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.isStarred, false);

    const saved = db.prepare('SELECT is_starred FROM article_states WHERE article_id = ?').get(ARTICLE_1_ID);
    assert.equal(saved?.is_starred, 0);
  });
});
