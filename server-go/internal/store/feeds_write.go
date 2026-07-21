package store

import (
	"database/sql"
	"strings"

	"rss-reader/server-go/internal/model"
)

// GetFeed fetches one feed row by id (for GET /api/feeds/:id/articles). ok=false
// when no row matches.
func GetFeed(r *sql.DB, id string) (model.Feed, bool, error) {
	var f model.Feed
	var last sql.NullInt64
	err := r.QueryRow(
		`SELECT id, name, url, last_fetched_at, COALESCE(push_enabled, 0) FROM feeds WHERE id = ?`, id).
		Scan(&f.ID, &f.Name, &f.URL, &last, &f.PushEnabled)
	if err == sql.ErrNoRows {
		return model.Feed{}, false, nil
	}
	if err != nil {
		return model.Feed{}, false, err
	}
	if last.Valid {
		v := last.Int64
		f.LastFetchedAt = &v
	}
	return f, true, nil
}

// FeedURLExists reports whether a feed with this URL is already registered — the
// up-front dupe guard for POST /api/feeds (idx_feeds_url is unique).
func FeedURLExists(r *sql.DB, url string) (bool, error) {
	var one int
	err := r.QueryRow(`SELECT 1 FROM feeds WHERE url = ? LIMIT 1`, url).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// FeedURLSet returns every registered feed URL as a set, for the OPML importer's
// skip-dupes check (mirrors the Set built from SELECT url FROM feeds).
func FeedURLSet(r *sql.DB) (map[string]bool, error) {
	rows, err := r.Query(`SELECT url FROM feeds`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	set := map[string]bool{}
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		set[u] = true
	}
	return set, rows.Err()
}

// IsUniqueViolation reports whether err is a UNIQUE-constraint failure — the
// backstop for the POST /api/feeds add race (two concurrent adds both pass the
// SELECT; the second INSERT trips idx_feeds_url).
func IsUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	// mattn/go-sqlite3 surfaces this as "UNIQUE constraint failed: ..." in the
	// error string; matching the text avoids importing the driver here.
	return strings.Contains(err.Error(), "UNIQUE constraint failed")
}

// InsertFeed inserts a new feed row. A UNIQUE-constraint error (see
// IsUniqueViolation) means a concurrent add already claimed the URL.
func InsertFeed(w *sql.DB, id, name, url string) error {
	_, err := w.Exec(`INSERT INTO feeds (id, name, url) VALUES (?, ?, ?)`, id, name, url)
	return err
}

// InsertFeedIgnore is the OPML path's INSERT OR IGNORE (dupes pre-filtered by the
// URL set, so this is belt-and-braces).
func InsertFeedIgnore(w *sql.DB, id, name, url string) error {
	_, err := w.Exec(`INSERT OR IGNORE INTO feeds (id, name, url) VALUES (?, ?, ?)`, id, name, url)
	return err
}

// RenameFeed updates a feed's name and returns the affected row count (0 = not
// found). The caller must pass a non-empty name — feeds.name is NOT NULL, and the
// PATCH handler rejects empty names before reaching here.
func RenameFeed(w *sql.DB, id, name string) (int64, error) {
	res, err := w.Exec(`UPDATE feeds SET name = ? WHERE id = ?`, name, id)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// DeleteFeed removes a feed and purges its non-starred articles in one
// transaction (port of the deleteFeed db.transaction). Starred rows are kept as
// orphans (durable-record design). Returns the feed-row change count (0 = not
// found; the article purge is skipped in that case, matching Node).
func DeleteFeed(w *sql.DB, id string) (int64, error) {
	tx, err := w.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	res, err := tx.Exec(`DELETE FROM feeds WHERE id = ?`, id)
	if err != nil {
		return 0, err
	}
	changes, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	if changes == 0 {
		return 0, tx.Commit()
	}
	if _, err := tx.Exec(
		`DELETE FROM article_states WHERE feed_id = ? AND is_starred = 0`, id); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return changes, nil
}

// AdoptStarredOrphans re-homes kept starred orphans back onto a re-added feed:
// rows whose feed_url matches and whose feed_id is no longer a live feed get the
// new feed_id + refreshed feed_name (port of adoptStarredOrphans / adoptOrphans).
// Returns the number of rows adopted.
func AdoptStarredOrphans(w *sql.DB, feedID, feedName, url string) (int64, error) {
	res, err := w.Exec(
		`UPDATE article_states SET feed_id = ?, feed_name = ?
		 WHERE feed_url = ? AND is_starred = 1 AND feed_id NOT IN (SELECT id FROM feeds)`,
		feedID, feedName, url)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
