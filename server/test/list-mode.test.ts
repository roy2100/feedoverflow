import assert from 'node:assert/strict';
import { test, describe, before } from 'node:test';

import request from 'supertest';

// Isolated in-memory DB — must be set before importing the server module.
process.env.TEST_DB = ':memory:';

const { app } = await import('../app.ts');
const { db } = await import('../db.ts');
const { persistItems } = await import('../articles.ts');

// Two feeds: a "firehose" whose volume exceeds the list cap (every item newer than the
// slow feed's), and a "slow" feed with a handful of older-but-still-today items. In `latest`
// mode the firehose fills the whole 500-row list and the slow feed is crowded out entirely;
// in `digest` mode the per-feed quota guarantees the slow feed is still represented.
const FIREHOSE = { id: 'firehose', name: 'Firehose', url: 'https://example.com/firehose.xml' };
const SLOW = { id: 'slow', name: 'Slow Blog', url: 'https://example.com/slow.xml' };
const FIREHOSE_COUNT = 600; // > LIST_LIMIT (500)
const SLOW_COUNT = 5;

function makeItems(prefix: string, count: number, baseMs: number) {
  return Array.from({ length: count }, (_, i) => {
    const iso = new Date(baseMs + i * 1000).toISOString();
    return {
      title: `${prefix} ${i}`,
      link: `https://example.com/${prefix}/${i}`,
      pubDate: iso,
      isoDate: iso,
      contentSnippet: '',
      content: '',
      contentEncoded: '',
    };
  });
}

before(() => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  for (const f of [FIREHOSE, SLOW]) {
    db.prepare('INSERT OR IGNORE INTO feeds (id, name, url) VALUES (?, ?, ?)').run(
      f.id,
      f.name,
      f.url,
    );
  }
  // Slow items sit just after midnight; firehose items are "now" — so every firehose item is
  // strictly newer than every slow item.
  persistItems(SLOW, makeItems('slow', SLOW_COUNT, todayStart.getTime() + 60_000), SLOW.name);
  persistItems(
    FIREHOSE,
    makeItems('fire', FIREHOSE_COUNT, Date.now() - FIREHOSE_COUNT * 1000),
    FIREHOSE.name,
  );
  for (const f of [FIREHOSE, SLOW]) {
    db.prepare('UPDATE feeds SET last_fetched_at = ? WHERE id = ?').run(Date.now(), f.id);
  }
});

function feedNames(articles: { feedName: string }[]) {
  return new Set(articles.map((a) => a.feedName));
}

describe('GET /api/all-articles — latest vs digest fairness', () => {
  test('latest mode lets the firehose crowd out the slow feed', async () => {
    const res = await request(app).get('/api/all-articles?mode=latest');
    assert.equal(res.status, 200);
    assert.equal(res.body.articles.length, 500);
    assert.ok(
      !feedNames(res.body.articles).has(SLOW.name),
      'slow feed should be absent in latest mode',
    );
  });

  test('digest mode guarantees the slow feed is represented', async () => {
    const res = await request(app).get('/api/all-articles?mode=digest');
    assert.equal(res.status, 200);
    const names = feedNames(res.body.articles);
    assert.ok(names.has(SLOW.name), 'slow feed should appear in digest mode');
    assert.ok(names.has(FIREHOSE.name), 'firehose feed should still appear in digest mode');
    const slowCount = res.body.articles.filter(
      (a: { feedName: string }) => a.feedName === SLOW.name,
    ).length;
    assert.equal(slowCount, SLOW_COUNT, 'all of the slow feed’s today items should be present');
  });

  test('absent/unknown mode defaults to latest (no per-feed quota)', async () => {
    const res = await request(app).get('/api/all-articles');
    assert.equal(res.body.articles.length, 500);
    assert.ok(!feedNames(res.body.articles).has(SLOW.name), 'default mode behaves like latest');
  });
});
