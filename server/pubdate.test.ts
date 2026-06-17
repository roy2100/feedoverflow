import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';

// articles.ts imports db.ts, which needs an isolated temp DB.
const TEST_DB_PATH = join(tmpdir(), `rss-pubdate-test-${process.pid}.db`);
process.env.TEST_DB = TEST_DB_PATH;

const { parsePubDate, byPubDateDesc, normalizePubDates } = await import('./articles.ts');

after(() => {
  try {
    unlinkSync(TEST_DB_PATH);
  } catch {
    /* ignore */
  }
});

// The non-standard shape some feeds emit (36氪 via RssHub): space instead of `T`, doubled
// whitespace, colon-less offset. Node's `new Date()` is lenient enough to parse it, but the
// browser's is not — which is exactly why parsing must live on the server (the source of
// truth) and reach the client as canonical ISO, instead of being re-parsed in two places.
const WEIRD = '2026-06-17 14:14:08  +0800';

test('parsePubDate yields canonical UTC for the non-standard RssHub format', () => {
  const d = parsePubDate(WEIRD);
  assert.ok(d, 'parser returns a Date');
  assert.equal(d.toISOString(), '2026-06-17T06:14:08.000Z'); // +08:00 → UTC
});

test('parsePubDate parses standard ISO/RFC822 and returns null for junk', () => {
  assert.ok(parsePubDate('2025-01-01T00:00:00Z'));
  assert.ok(parsePubDate('Tue, 26 May 2026 10:59:16 +0800'));
  assert.equal(parsePubDate(''), null);
  assert.equal(parsePubDate(null), null);
  assert.equal(parsePubDate('not a date'), null);
});

test('byPubDateDesc orders newest first, including the non-standard format, no NaN', () => {
  const items = [
    { pubDate: '2026-06-17 10:00:00  +0800' }, // weird, older
    { pubDate: '2026-06-17T08:00:00Z' }, // = 16:00 +08:00, newest
    { pubDate: 'garbage' }, // unparseable → sinks to bottom
  ];
  items.sort(byPubDateDesc);
  assert.deepEqual(
    items.map((i) => i.pubDate),
    ['2026-06-17T08:00:00Z', '2026-06-17 10:00:00  +0800', 'garbage'],
  );
});

test('normalizePubDates rewrites parseable dates to ISO, leaves junk untouched', () => {
  const articles = [{ pubDate: WEIRD }, { pubDate: 'garbage' }];
  normalizePubDates(articles);
  assert.equal(articles[0].pubDate, '2026-06-17T06:14:08.000Z');
  assert.equal(articles[1].pubDate, 'garbage');
});
