// Integration test — real network, no mocks.
// Verifies the trailing-slash redirect bug is fixed:
// https://www.coindesk.com/arc/outboundfeeds/rss/ (with slash) used to fail
// with "bad record mac" because the 308 redirect triggered a new TLS connection
// that the proxy couldn't handle via session resumption.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseURL } = require('./index.ts');

test('coindesk: trailing-slash URL returns articles', async () => {
  const feed = await parseURL('https://www.coindesk.com/arc/outboundfeeds/rss/');
  assert.ok(Array.isArray(feed.items), 'items should be an array');
  assert.ok(feed.items.length > 0, 'should have at least one article');
  const first = feed.items[0];
  assert.ok(first.title, 'article should have a title');
  assert.ok(first.link, 'article should have a link');
});

test('coindesk: non-trailing-slash URL also works', async () => {
  const feed = await parseURL('https://www.coindesk.com/arc/outboundfeeds/rss');
  assert.ok(feed.items.length > 0, 'should have at least one article');
});
