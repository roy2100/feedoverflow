import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseURL } from './parse-url.ts';

const SSPAI_URL = 'https://sspai.com/feed';

test('sspai: feed returns articles', async () => {
  const feed = await parseURL(SSPAI_URL);
  assert.ok(feed.items.length > 0, 'should have at least one article');
});

test('sspai: articles have required fields', async () => {
  const feed = await parseURL(SSPAI_URL);
  const first = feed.items[0];
  assert.ok(first.title, 'article should have a title');
  assert.ok(first.link, 'article should have a link');
});

test('sspai: titles are correctly decoded as chinese', async () => {
  const feed = await parseURL(SSPAI_URL);
  const hasChinese = feed.items.some((item) => /[一-鿿]/.test(item.title ?? ''));
  assert.ok(hasChinese, 'at least one title should contain Chinese characters');
});
