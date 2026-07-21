// Package db owns the SQLite connection, schema, and migrations. It is the Go
// counterpart to server/db.ts and reuses the same rss.db file/schema.
//
// The migration chain began as a verbatim port of db.ts (same statement text and
// ALTER order — see docs/plan-go-backend-migration.md Phase 1) and has since
// diverged as the Go build gained its own columns (e.g. starred_at). Migrations
// stay strictly additive and idempotent so the single live rss.db and every fresh
// DB both converge on the same schema; column *order* is deliberately not pinned
// (all queries use explicit named column lists, never positional SELECT *).
//
// Known production drift (decided: ignore, do not "fix"): the live rss.db carries
// a dead `feeds.category` column from a removed feature. It is harmless as long
// as this package never references `category` — which, per the named-column rule
// above, it doesn't.
package db

import (
	"database/sql"
	"fmt"

	_ "github.com/mattn/go-sqlite3"
)

// DB is the server's handle: a read pool (concurrent readers) plus a single-conn
// write pool. SQLite is single-writer; capping the write pool to one connection
// serializes Go's writers so they queue instead of racing for the SQLite write
// lock (the Go equivalent of the discipline that fixed the Node stall). Both
// pools open the same WAL file — readers see committed writes.
type DB struct {
	read  *sql.DB
	write *sql.DB
}

// OpenHandle opens the read and write pools for path.
func OpenHandle(path string) (*DB, error) {
	read, err := Open(path)
	if err != nil {
		return nil, err
	}
	write, err := Open(path)
	if err != nil {
		read.Close()
		return nil, err
	}
	write.SetMaxOpenConns(1)
	return &DB{read: read, write: write}, nil
}

// Reader returns the concurrent read pool. Writer returns the single-writer pool.
func (d *DB) Reader() *sql.DB { return d.read }
func (d *DB) Writer() *sql.DB { return d.write }

// Close closes both pools.
func (d *DB) Close() error {
	we := d.write.Close()
	re := d.read.Close()
	if we != nil {
		return we
	}
	return re
}

// Open opens (creating if absent) the SQLite database at path with the same
// pragmas the Node build uses: WAL journal, synchronous=NORMAL, plus a
// busy_timeout so concurrent readers/writers wait instead of erroring. The
// pragmas go in the DSN so every pooled connection inherits them.
func Open(path string) (*sql.DB, error) {
	dsn := "file:" + path + "?_busy_timeout=5000&_journal_mode=WAL&_synchronous=NORMAL"
	sqldb, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, err
	}
	if err := sqldb.Ping(); err != nil {
		sqldb.Close()
		return nil, err
	}
	return sqldb, nil
}

// InitSchema creates tables, runs the idempotent migrations, and seeds defaults —
// the Go port of the top-level statements in db.ts. Safe to re-run.
func InitSchema(db *sql.DB) error {
	// Base schema — text copied verbatim from db.ts so the stored CREATE
	// statements (and thus `.schema`) match exactly.
	if _, err := db.Exec(`
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
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_keys (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    public_key  TEXT NOT NULL,
    private_key TEXT NOT NULL
  );
`); err != nil {
		return fmt.Errorf("base schema: %w", err)
	}

	// Idempotent column migrations — each ignored if it already applied (the Go
	// equivalent of db.ts's try/catch around ALTER). Order is load-bearing: it
	// determines the column order in the stored article_states schema.
	execIgnore(db, `ALTER TABLE article_states ADD COLUMN audio_url      TEXT DEFAULT ''`)
	execIgnore(db, `ALTER TABLE article_states ADD COLUMN audio_duration TEXT DEFAULT ''`)
	// Drop the retired read/unread column (throws + ignored on a fresh DB).
	execIgnore(db, `ALTER TABLE article_states DROP COLUMN is_read`)
	// Per-feed last-fetch timestamp (epoch ms).
	execIgnore(db, `ALTER TABLE feeds ADD COLUMN last_fetched_at INTEGER`)
	// Content-edit timestamp (epoch ms); NULL until first upstream edit.
	execIgnore(db, `ALTER TABLE article_states ADD COLUMN content_updated_at INTEGER`)
	// Sortable publish time (epoch ms).
	execIgnore(db, `ALTER TABLE article_states ADD COLUMN pub_ts INTEGER`)
	// Star-action time (epoch ms); NULL until first starred. Drives the /api/starred
	// order (newest-starred first) independent of publish date.
	execIgnore(db, `ALTER TABLE article_states ADD COLUMN starred_at INTEGER`)
	// Per-feed Web Push opt-in (default off) and the notification watermark: the
	// highest pub_ts already pushed for this feed. NULL means "never notified" —
	// the poller seeds it to now rather than replaying the backlog.
	execIgnore(db, `ALTER TABLE feeds ADD COLUMN push_enabled INTEGER DEFAULT 0`)
	execIgnore(db, `ALTER TABLE feeds ADD COLUMN last_notified_ts INTEGER`)

	if _, err := db.Exec(
		`CREATE INDEX IF NOT EXISTS idx_article_states_feed_pub ON article_states (feed_id, pub_ts)`,
	); err != nil {
		return fmt.Errorf("idx feed_pub: %w", err)
	}
	if _, err := db.Exec(
		`CREATE INDEX IF NOT EXISTS idx_article_states_pub ON article_states (pub_ts)`,
	); err != nil {
		return fmt.Errorf("idx pub: %w", err)
	}
	// Backfill starred_at for pre-existing starred rows (one-time, before the index
	// below keys on it): seed from updated_at (text datetime → epoch ms), falling back
	// to pub_ts then 0, so the invariant is_starred = 1 ⟹ starred_at NOT NULL holds.
	if _, err := db.Exec(`
  UPDATE article_states
     SET starred_at = COALESCE(CAST(strftime('%s', updated_at) AS INTEGER) * 1000, pub_ts, 0)
   WHERE is_starred = 1 AND starred_at IS NULL`,
	); err != nil {
		return fmt.Errorf("starred_at backfill: %w", err)
	}
	// Partial index over starred rows only: GET /api/starred and /api/starred/count
	// filter on is_starred = 1, a tiny fraction of the (potentially 100k+ row) table.
	// Without it those queries full-scan the whole pub_ts index and do a table lookup
	// per row to check is_starred (~800ms on a 440MB DB). Keying the starred rows by
	// starred_at DESC serves both the newest-starred-first list and the count index-only.
	// Drop the prior pub_ts-keyed variant so this definition wins on existing DBs.
	if _, err := db.Exec(`DROP INDEX IF EXISTS idx_article_states_starred`); err != nil {
		return fmt.Errorf("drop old idx starred: %w", err)
	}
	if _, err := db.Exec(
		`CREATE INDEX IF NOT EXISTS idx_article_states_starred ON article_states (starred_at DESC) WHERE is_starred = 1`,
	); err != nil {
		return fmt.Errorf("idx starred: %w", err)
	}
	// Partial index over audio-bearing rows only: GET /api/podcasts filters on a
	// non-empty audio_url (a small slice of the table) and orders by pub_ts. Without
	// it that query full-scans the table and builds a temp B-tree to sort (~800ms on a
	// 440MB DB). Keying the podcast rows by pub_ts makes the read index-only, no sort.
	// The old idx_article_states_podcast keyed on the text pub_date column, which sorts
	// day-of-week-first and buried the newest episodes; drop it in favor of the pub_ts key.
	if _, err := db.Exec(`DROP INDEX IF EXISTS idx_article_states_podcast`); err != nil {
		return fmt.Errorf("drop old idx podcast: %w", err)
	}
	if _, err := db.Exec(
		`CREATE INDEX IF NOT EXISTS idx_article_states_podcast_ts ON article_states (pub_ts DESC) WHERE audio_url IS NOT NULL AND audio_url != ''`,
	); err != nil {
		return fmt.Errorf("idx podcast: %w", err)
	}

	// pub_ts backfill: db.ts recomputes pub_ts for pre-existing NULL rows via
	// pubTs(). That is domain logic ported in Phase 2. It is a no-op on a fresh
	// DB (no rows) and on our parity copy (Node already populated pub_ts), so we
	// only assert the invariant here and defer the actual computation.
	var nullPubTs int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM article_states WHERE pub_ts IS NULL`,
	).Scan(&nullPubTs); err != nil {
		return fmt.Errorf("pub_ts null count: %w", err)
	}
	if nullPubTs > 0 {
		// Surface rather than silently skip — Phase 2 wires pubTs() here.
		return fmt.Errorf("phase1: %d rows have NULL pub_ts; backfill needs pubTs() (Phase 2)", nullPubTs)
	}

	// Originating feed URL. Add column, then backfill from the live feed where it
	// still exists (pure SQL — ported verbatim).
	execIgnore(db, `ALTER TABLE article_states ADD COLUMN feed_url TEXT`)
	if _, err := db.Exec(`
  UPDATE article_states
     SET feed_url = (SELECT url FROM feeds WHERE feeds.id = article_states.feed_id)
   WHERE feed_url IS NULL AND feed_id IN (SELECT id FROM feeds)`,
	); err != nil {
		return fmt.Errorf("feed_url backfill: %w", err)
	}

	// Drop the retired feed_cache table.
	if _, err := db.Exec(`DROP TABLE IF EXISTS feed_cache`); err != nil {
		return fmt.Errorf("drop feed_cache: %w", err)
	}

	// Enforce feed-URL uniqueness. The one-time dup-collapse this index once
	// depended on is retired: the live DB was long since collapsed, this
	// constraint has prevented new dups since, and a fresh DB never has any.
	if _, err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_url ON feeds (url)`); err != nil {
		return fmt.Errorf("unique feeds url: %w", err)
	}

	// Seed default settings + feeds.
	if _, err := db.Exec(
		`INSERT OR IGNORE INTO settings (key, value) VALUES ('rsshub_base_url', 'http://localhost:1200')`,
	); err != nil {
		return fmt.Errorf("seed settings: %w", err)
	}
	if err := seedDefaultFeeds(db); err != nil {
		return err
	}
	return nil
}

// seedDefaultFeeds inserts the four starter feeds only when the table is empty,
// matching db.ts.
func seedDefaultFeeds(db *sql.DB) error {
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM feeds`).Scan(&n); err != nil {
		return err
	}
	if n != 0 {
		return nil
	}
	defaults := [][3]string{
		{"1", "少数派", "https://sspai.com/feed"},
		{"2", "虎嗅", "https://feeds.feedburner.com/huxiu"},
		{"3", "36氪", "https://36kr.com/feed"},
		{"4", "阮一峰的网络日志", "https://feeds.feedburner.com/ruanyifeng"},
	}
	for _, d := range defaults {
		if _, err := db.Exec(`INSERT INTO feeds (id,name,url) VALUES (?,?,?)`, d[0], d[1], d[2]); err != nil {
			return err
		}
	}
	return nil
}

// execIgnore runs an idempotent DDL statement, discarding the error a re-run
// produces (duplicate/absent column) — the Go equivalent of db.ts's try/catch.
func execIgnore(db *sql.DB, stmt string) {
	_, _ = db.Exec(stmt)
}
