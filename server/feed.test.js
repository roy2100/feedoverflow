/**
 * Integration tests for feed parsing (direct connection, no proxy).
 * Run: cd server && npm test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseURL } = require('./index.js');

test('Reddit /r/rss feed — direct connection', async (t) => {
  const REDDIT_RSS = 'https://www.reddit.com/r/rss.rss';

  let feed;
  try {
    feed = await parseURL(REDDIT_RSS);
  } catch (err) {
    assert.fail(`parseURL threw: ${err.message}`);
  }

  await t.test('feed has a title', () => {
    assert.ok(typeof feed.title === 'string' && feed.title.length > 0,
      `expected non-empty title, got: ${JSON.stringify(feed.title)}`);
  });

  await t.test('feed has items', () => {
    assert.ok(Array.isArray(feed.items) && feed.items.length > 0,
      `expected at least one item, got ${feed.items?.length ?? 0}`);
  });

  await t.test('every item has title and link', () => {
    for (const item of feed.items) {
      assert.ok(typeof item.title === 'string' && item.title.length > 0,
        `item missing title: ${JSON.stringify(item)}`);
      assert.ok(typeof item.link === 'string' && item.link.startsWith('http'),
        `item missing link: ${JSON.stringify(item)}`);
    }
  });

  await t.test('every item has a publication date', () => {
    for (const item of feed.items) {
      const d = new Date(item.pubDate || item.isoDate || '');
      assert.ok(!isNaN(d.getTime()),
        `item has invalid/missing date: ${JSON.stringify({ title: item.title, pubDate: item.pubDate })}`);
    }
  });
});
