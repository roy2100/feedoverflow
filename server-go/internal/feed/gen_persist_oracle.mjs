// Persist-parity oracle: parse a saved feed XML with the EXACT rss-parser config
// from server/parse-url.ts, run the real persistItems (server/articles.ts) against
// a scratch TEST_DB, and print the resulting article_states rows as canonical JSON
// keyed by article_id. The Go itest parses the same bytes with gofeed, persists,
// and diffs — proving field-mapping parity (Phase 6).
//
// Usage: TEST_DB=/tmp/o.db node gen_persist_oracle.mjs <xml> <feedId> <feedName> <feedUrl>
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '../../../server');
const require = createRequire(path.join(serverDir, 'package.json'));
const Parser = require('rss-parser');

const [xmlPath, feedId, feedName, feedUrl] = process.argv.slice(2);
const xml = readFileSync(xmlPath, 'utf8');

// Must mirror makeParser() in server/parse-url.ts exactly.
const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'RSS-Reader/1.0' },
  customFields: { item: [['content:encoded', 'contentEncoded']] },
});

const { db } = await import(path.join(serverDir, 'db.ts'));
const { persistItems } = await import(path.join(serverDir, 'articles.ts'));

const parsed = await parser.parseString(xml);
const feed = { id: feedId, name: feedName, url: feedUrl };
persistItems(feed, parsed.items, parsed.title || feedName);

const cols = [
  'article_id', 'feed_id', 'feed_name', 'feed_url', 'title', 'link', 'pub_date',
  'summary', 'content', 'author', 'audio_url', 'audio_duration', 'is_starred',
];
const rows = db
  .prepare(`SELECT ${cols.join(',')} FROM article_states ORDER BY article_id`)
  .all();
const out = {};
for (const r of rows) out[r.article_id] = r;
process.stdout.write(JSON.stringify(out, null, 2));
