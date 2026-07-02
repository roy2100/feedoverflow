// Golden-oracle generator for the Phase 2 date/id parity test. Runs the REAL
// server dates.ts + articles.ts against every distinct pub_date in a DB copy
// (plus hand-picked edge cases) and emits JSON the Go golden test consumes.
//
// Usage: TZ=Asia/Shanghai node gen_oracle.mjs <db-path> > oracle.json
// Run with TZ pinned to the server's zone so zoneless dates match production.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parsePubDate, pubTs } from '../../../server/dates.ts';
import { makeId, normalizeDuration } from '../../../server/articles.ts';

// better-sqlite3 lives in server/node_modules; resolve it from there. Importing
// articles.ts above already loaded db.ts, which opens TEST_DB (set a scratch path
// when running) and prepares its statements — kept off the real dev/prod DB.
const serverDir = fileURLToPath(new URL('../../../server/', import.meta.url));
const Database = createRequire(serverDir)('better-sqlite3');

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: gen_oracle.mjs <db-path>');
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const rows = db
  .prepare(`SELECT DISTINCT pub_date FROM article_states WHERE pub_date IS NOT NULL`)
  .all();

const edgeCases = [
  '',
  'Invalid Date',
  'not a date at all',
  'Fri, 01 Aug 2025 00:30:00 GMT',
  'Fri, 01 Apr 2022 09:53:30 +0000',
  '2020-04-30T00:38:11.000Z',
  '2026-05-26 10:44:02  +0800',
  '2026-05-26  01:05:11',
  'Mon, 25 May 2026 10:15:39 ',
  '2026-06-17 14:14:08  +0800',
  '2026-06-17T06:14:08+00:00',
  'Fri, 5 Jun 2026 00:00:00 +0000', // single-digit day — V8 parses, Go padded `02` rejects
  'Sun, 7 Jun 2026 09:30:00', // single-digit day, zoneless
];

const inputs = [...new Set([...rows.map((r) => r.pub_date), ...edgeCases])];

const dates = inputs.map((input) => {
  const d = parsePubDate(input);
  const ms = d ? d.getTime() : null;
  return { input, ms, iso: ms === null ? null : new Date(ms).toISOString() };
});

// pubTs parity with a fixed fallback so the fallback branch is deterministic.
const FALLBACK = 1234567890000;
const pubTsCases = dates.map((d) => ({ input: d.input, pubTs: pubTs(d.input, FALLBACK) }));

// makeId cases: real link-bearing rows dominate; add fallback-branch cases too.
const idCases = [
  { link: 'https://example.com/a', title: 'T', pubDate: 'P' },
  { link: '', title: 'Title Only', pubDate: '2020-01-01' },
  { link: '', title: '', pubDate: '' },
  { link: 'https://例子.测试/路径?q=中文', title: 'x', pubDate: 'y' },
].map((c) => ({ ...c, id: makeId(c.link, c.title, c.pubDate) }));

// normalizeDuration cases.
const durInputs = ['', '1:23', '1:02:03', '3600', '90', '7325', 'abc', '61', '0'];
const durCases = durInputs.map((input) => ({ input, out: normalizeDuration(input) }));

process.stdout.write(
  JSON.stringify({ fallback: FALLBACK, dates, pubTsCases, idCases, durCases }, null, 0),
);
