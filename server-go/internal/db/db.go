// Package db owns the SQLite connection, schema, and migrations. It is the Go
// counterpart to server/db.ts and reuses the same rss.db file/schema unchanged.
//
// The schema/migration SQL is copied verbatim from db.ts (same statement text,
// same ALTER order) so `sqlite3 .schema` is byte-identical between the Node and
// Go builds — see docs/plan-go-backend-migration.md Phase 1.
//
// Known production drift (decided: ignore, do not "fix"): the live rss.db carries
// a dead `feeds.category` column (from a removed feature; unused by current code)
// and a frozen article_states column order (pub_ts before content_updated_at).
// Both are identical drift under Node — a fresh Node DB matches the Go fresh init,
// and the live Node app already runs against this file. Parity rules that follow:
// this package never references `category`, and all queries use explicit named
// column lists (never positional SELECT *) so column order is irrelevant.
package db

import (
	"database/sql"
	"fmt"

	_ "github.com/mattn/go-sqlite3"
)

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

	// Collapse any duplicate feed URLs (keep oldest rowid, re-home losers'
	// articles, delete loser rows), then enforce uniqueness with an index.
	if err := collapseDuplicateFeeds(db); err != nil {
		return err
	}
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

// collapseDuplicateFeeds mirrors the dup-URL collapse transaction in db.ts.
func collapseDuplicateFeeds(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	rows, err := tx.Query(`SELECT url FROM feeds GROUP BY url HAVING COUNT(*) > 1`)
	if err != nil {
		return err
	}
	var dupURLs []string
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			rows.Close()
			return err
		}
		dupURLs = append(dupURLs, u)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, url := range dupURLs {
		fr, err := tx.Query(`SELECT id, name FROM feeds WHERE url = ? ORDER BY rowid`, url)
		if err != nil {
			return err
		}
		type feedRow struct{ id, name string }
		var frows []feedRow
		for fr.Next() {
			var f feedRow
			if err := fr.Scan(&f.id, &f.name); err != nil {
				fr.Close()
				return err
			}
			frows = append(frows, f)
		}
		fr.Close()
		if err := fr.Err(); err != nil {
			return err
		}
		if len(frows) == 0 {
			continue
		}
		winner := frows[0]
		for _, loser := range frows[1:] {
			if _, err := tx.Exec(
				`UPDATE article_states SET feed_id = ?, feed_name = ? WHERE feed_id = ?`,
				winner.id, winner.name, loser.id,
			); err != nil {
				return err
			}
			if _, err := tx.Exec(`DELETE FROM feeds WHERE id = ?`, loser.id); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
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
