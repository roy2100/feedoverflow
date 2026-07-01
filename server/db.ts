import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { pubTs } from './dates.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const dbPath = process.env.TEST_DB || path.join(__dirname, 'rss.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS feeds (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS article_states (
    article_id TEXT PRIMARY KEY,
    feed_id    TEXT,
    feed_name  TEXT,
    title      TEXT,
    link       TEXT,
    pub_date   TEXT,
    summary    TEXT,
    content    TEXT,
    author     TEXT,
    is_starred INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS favicon_cache (
    domain       TEXT PRIMARY KEY,
    image        BLOB,
    content_type TEXT,
    fetched_at   INTEGER
  );
`);

// Migrate: add podcast columns if not yet present (safe to re-run)
try {
  db.exec(`ALTER TABLE article_states ADD COLUMN audio_url      TEXT DEFAULT ''`);
} catch {}
try {
  db.exec(`ALTER TABLE article_states ADD COLUMN audio_duration TEXT DEFAULT ''`);
} catch {}

// Migrate: drop the retired read/unread column. The feature was removed; article_states is
// now a durable record for statistics/research, with no read state. Throws (and is ignored)
// on a fresh DB where the column was never created.
try {
  db.exec(`ALTER TABLE article_states DROP COLUMN is_read`);
} catch {}

// Migrate: per-feed last-fetch timestamp (epoch ms). Replaces feed_cache.fetched_at as the
// freshness signal that drives refresh scheduling.
try {
  db.exec(`ALTER TABLE feeds ADD COLUMN last_fetched_at INTEGER`);
} catch {}

// Migrate: content-edit timestamp (epoch ms). Set only when a re-fetch changes an article's
// content fields (see persistItems' upsert) — NOT on first insert, starring, or a feed
// re-home. NULL therefore means "never edited upstream since first seen", which the UI uses
// to decide whether to show an "updated" time.
try {
  db.exec(`ALTER TABLE article_states ADD COLUMN content_updated_at INTEGER`);
} catch {}

// Migrate: sortable publish time (epoch ms) on article_states. pub_date is RFC-822 text and
// not orderable as a string, so list endpoints sort/filter on pub_ts instead. Backfill any
// pre-existing rows (NULL pub_ts) from pub_date, falling back to updated_at then 0.
try {
  db.exec(`ALTER TABLE article_states ADD COLUMN pub_ts INTEGER`);
} catch {}
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_article_states_feed_pub ON article_states (feed_id, pub_ts)`,
);
// Standalone pub_ts index for the merged-list "latest" path: a global ORDER BY pub_ts DESC
// LIMIT N walks this backward and stops at N, avoiding a full-table scan + sort. The composite
// (feed_id, pub_ts) index can't serve a global ordering (feed_id is the leading column), and is
// used instead by the per-feed "digest" path.
db.exec(`CREATE INDEX IF NOT EXISTS idx_article_states_pub ON article_states (pub_ts)`);
{
  const { n } = db
    .prepare(`SELECT COUNT(*) AS n FROM article_states WHERE pub_ts IS NULL`)
    .get() as { n: number };
  if (n > 0) {
    const rows = db
      .prepare(`SELECT article_id, pub_date, updated_at FROM article_states WHERE pub_ts IS NULL`)
      .all() as Array<{ article_id: string; pub_date: string | null; updated_at: string | null }>;
    const upd = db.prepare(`UPDATE article_states SET pub_ts = ? WHERE article_id = ?`);
    db.transaction(() => {
      for (const r of rows) {
        const fallback = r.updated_at ? Date.parse(r.updated_at) : NaN;
        upd.run(pubTs(r.pub_date, Number.isNaN(fallback) ? 0 : fallback), r.article_id);
      }
    })();
  }
}

// Migrate: remember each article's originating feed URL. feed_id points at a feeds row that
// DELETE removes, so a kept starred article becomes an orphan with a dead feed_id and no way
// back to its feed. feed_url survives feed deletion, letting a re-added URL adopt its own
// starred orphans (see adoptStarredOrphans). Backfill from the live feed where it still
// exists; pre-existing orphans (feed already gone) have no URL to recover and stay NULL.
try {
  db.exec(`ALTER TABLE article_states ADD COLUMN feed_url TEXT`);
} catch {}
db.exec(
  `UPDATE article_states
     SET feed_url = (SELECT url FROM feeds WHERE feeds.id = article_states.feed_id)
   WHERE feed_url IS NULL AND feed_id IN (SELECT id FROM feeds)`,
);

// Migrate: drop the retired feed_cache table. Its items_json duplicated article_states list
// metadata; freshness now lives in feeds.last_fetched_at and lists read from article_states.
db.exec(`DROP TABLE IF EXISTS feed_cache`);

// Migrate: enforce one feed row per URL. The add route historically inserted unconditionally,
// so a URL could be added twice under different ids. Duplicates split article ownership
// (article_states.feed_id is set only on insert), so first collapse any existing dupes —
// keep the oldest row (min rowid) per URL, re-home the losers' articles onto it, delete the
// loser feed rows — then add a UNIQUE index so it can't recur (a unique index, not ALTER TABLE
// ADD CONSTRAINT, which SQLite doesn't support). The index creation must follow the collapse.
db.transaction(() => {
  const dupUrls = db
    .prepare(`SELECT url FROM feeds GROUP BY url HAVING COUNT(*) > 1`)
    .all() as Array<{ url: string }>;
  const rehome = db.prepare(
    `UPDATE article_states SET feed_id = ?, feed_name = ? WHERE feed_id = ?`,
  );
  const delFeed = db.prepare(`DELETE FROM feeds WHERE id = ?`);
  for (const { url } of dupUrls) {
    const rows = db
      .prepare(`SELECT id, name FROM feeds WHERE url = ? ORDER BY rowid`)
      .all(url) as Array<{ id: string; name: string }>;
    const [winner, ...losers] = rows;
    for (const loser of losers) {
      rehome.run(winner.id, winner.name, loser.id);
      delFeed.run(loser.id);
    }
  }
})();
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_url ON feeds (url)`);

// Seed default settings
db.prepare(
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('rsshub_base_url', 'http://localhost:1200')`,
).run();

// Seed default feeds once
if ((db.prepare('SELECT COUNT(*) AS n FROM feeds').get() as { n: number }).n === 0) {
  const ins = db.prepare('INSERT INTO feeds (id,name,url) VALUES (?,?,?)');
  (
    [
      ['1', '少数派', 'https://sspai.com/feed'],
      ['2', '虎嗅', 'https://feeds.feedburner.com/huxiu'],
      ['3', '36氪', 'https://36kr.com/feed'],
      ['4', '阮一峰的网络日志', 'https://feeds.feedburner.com/ruanyifeng'],
    ] as const
  ).forEach((r) => ins.run(...r));
}
