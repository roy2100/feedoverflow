import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

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
    is_read    INTEGER DEFAULT 0,
    is_starred INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS feed_cache (
    feed_id    TEXT PRIMARY KEY,
    feed_name  TEXT,
    items_json TEXT,
    fetched_at INTEGER
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
