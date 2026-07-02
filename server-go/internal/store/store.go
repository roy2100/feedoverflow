// Package store holds the read queries against article_states/feeds/settings —
// the SQL that lives inline in the Node route handlers, factored out here. All
// queries use explicit named column lists (never SELECT *) so column order and
// the dead `category` column are irrelevant (see db.go).
package store

import (
	"database/sql"
	"strings"

	"rss-reader/server-go/internal/articles"
	"rss-reader/server-go/internal/model"
)

// The article_states columns RowToArticle needs, in scan order.
const articleCols = `article_id, feed_id, feed_name, title, link, pub_date,
	summary, content, author, audio_url, audio_duration, is_starred, content_updated_at`

func scanArticleRows(rows *sql.Rows) ([]articles.Row, error) {
	defer rows.Close()
	var out []articles.Row
	for rows.Next() {
		var r articles.Row
		if err := rows.Scan(
			&r.ArticleID, &r.FeedID, &r.FeedName, &r.Title, &r.Link, &r.PubDate,
			&r.Summary, &r.Content, &r.Author, &r.AudioURL, &r.AudioDuration,
			&r.IsStarred, &r.ContentUpdatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ListFeeds — GET /api/feeds: raw feed rows ordered by rowid (category omitted).
func ListFeeds(db *sql.DB) ([]model.Feed, error) {
	rows, err := db.Query(`SELECT id, name, url, last_fetched_at FROM feeds ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	feeds := []model.Feed{}
	for rows.Next() {
		var f model.Feed
		var last sql.NullInt64
		if err := rows.Scan(&f.ID, &f.Name, &f.URL, &last); err != nil {
			return nil, err
		}
		if last.Valid {
			v := last.Int64
			f.LastFetchedAt = &v
		}
		feeds = append(feeds, f)
	}
	return feeds, rows.Err()
}

// FeedIDs returns feed ids in rowid order (for the digest per-feed fan-out).
func FeedIDs(db *sql.DB) ([]string, error) {
	rows, err := db.Query(`SELECT id FROM feeds ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// NewestGlobal — latest mode: global newest N by pub_ts.
func NewestGlobal(db *sql.DB, limit int) ([]articles.Row, error) {
	rows, err := db.Query(
		`SELECT `+articleCols+` FROM article_states ORDER BY pub_ts DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	return scanArticleRows(rows)
}

// SinceGlobal — today latest mode: global newest N since a pub_ts cutoff.
func SinceGlobal(db *sql.DB, since int64, limit int) ([]articles.Row, error) {
	rows, err := db.Query(
		`SELECT `+articleCols+` FROM article_states WHERE pub_ts >= ? ORDER BY pub_ts DESC LIMIT ?`,
		since, limit)
	if err != nil {
		return nil, err
	}
	return scanArticleRows(rows)
}

// NewestByFeed — digest mode: newest quota rows for one feed.
func NewestByFeed(db *sql.DB, feedID string, limit int) ([]articles.Row, error) {
	rows, err := db.Query(
		`SELECT `+articleCols+` FROM article_states WHERE feed_id = ? ORDER BY pub_ts DESC LIMIT ?`,
		feedID, limit)
	if err != nil {
		return nil, err
	}
	return scanArticleRows(rows)
}

// SinceByFeed — today digest mode: newest quota rows for one feed since a cutoff.
func SinceByFeed(db *sql.DB, feedID string, since int64, limit int) ([]articles.Row, error) {
	rows, err := db.Query(
		`SELECT `+articleCols+` FROM article_states
		 WHERE feed_id = ? AND pub_ts >= ? ORDER BY pub_ts DESC LIMIT ?`,
		feedID, since, limit)
	if err != nil {
		return nil, err
	}
	return scanArticleRows(rows)
}

// Starred — GET /api/starred: starred rows, newest-updated first.
func Starred(db *sql.DB) ([]articles.Row, error) {
	rows, err := db.Query(
		`SELECT ` + articleCols + ` FROM article_states WHERE is_starred = 1 ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	return scanArticleRows(rows)
}

// Podcasts — GET /api/podcasts: audio-bearing rows, coarse pub_date sort, cap 200.
func Podcasts(db *sql.DB) ([]articles.Row, error) {
	rows, err := db.Query(
		`SELECT ` + articleCols + ` FROM article_states
		 WHERE audio_url IS NOT NULL AND audio_url != ''
		 ORDER BY pub_date DESC LIMIT 200`)
	if err != nil {
		return nil, err
	}
	return scanArticleRows(rows)
}

// StarredCount — GET /api/starred/count.
func StarredCount(db *sql.DB) (int64, error) {
	var n int64
	err := db.QueryRow(`SELECT COUNT(*) FROM article_states WHERE is_starred = 1`).Scan(&n)
	return n, err
}

// LookupContent is the port of lookupContent: content, else summary, else "".
func LookupContent(db *sql.DB, id string) (string, error) {
	var content, summary sql.NullString
	err := db.QueryRow(
		`SELECT content, summary FROM article_states WHERE article_id = ?`, id).Scan(&content, &summary)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if content.String != "" {
		return content.String, nil
	}
	return summary.String, nil
}

// FeedHasRows reports whether article_states already holds any row for a feed —
// the `SELECT 1 FROM article_states WHERE feed_id = ? LIMIT 1` guard ensureFresh
// uses to tell a brand-new feed (await first fetch) from one that only needs a
// background refresh.
func FeedHasRows(db *sql.DB, feedID string) (bool, error) {
	var one int
	err := db.QueryRow(`SELECT 1 FROM article_states WHERE feed_id = ? LIMIT 1`, feedID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ResolveURL is the port of resolveUrl (articles.ts): rsshub://path expands to
// <rsshub_base_url>/path, with the base taken from settings (default
// http://localhost:1200) and its trailing slash trimmed. Non-rsshub URLs pass
// through unchanged.
func ResolveURL(db *sql.DB, url string) (string, error) {
	const scheme = "rsshub://"
	if url == "" || !strings.HasPrefix(url, scheme) {
		return url, nil
	}
	base := "http://localhost:1200"
	var v sql.NullString
	err := db.QueryRow(`SELECT value FROM settings WHERE key = 'rsshub_base_url'`).Scan(&v)
	if err != nil && err != sql.ErrNoRows {
		return "", err
	}
	if v.Valid && v.String != "" {
		base = v.String
	}
	// Node uses base.replace(/\/$/, '') — strips exactly one trailing slash.
	return strings.TrimSuffix(base, "/") + "/" + url[len(scheme):], nil
}

// Search — GET /api/search: LIKE across title/summary/content, optionally scoped
// to starred or one feed, newest-by-text-pub_date first, cap 200 (the caller
// re-sorts by parsed date and slices to 100). Port of routes/search.ts. `like` is
// the already-escaped pattern (ESCAPE '\'); scope is "starred" | "feed" | "".
func Search(r *sql.DB, like, scope, feedID string) ([]articles.Row, error) {
	q := `SELECT ` + articleCols + ` FROM article_states
		WHERE (title LIKE ? ESCAPE '\' OR summary LIKE ? ESCAPE '\' OR content LIKE ? ESCAPE '\')`
	args := []any{like, like, like}
	switch {
	case scope == "starred":
		q += ` AND is_starred = 1`
	case scope == "feed" && feedID != "":
		q += ` AND feed_id = ?`
		args = append(args, feedID)
	}
	q += ` ORDER BY pub_date DESC LIMIT 200`
	rows, err := r.Query(q, args...)
	if err != nil {
		return nil, err
	}
	return scanArticleRows(rows)
}

// Settings — GET /api/settings: all key/value pairs as a flat map.
func Settings(db *sql.DB) (map[string]string, error) {
	rows, err := db.Query(`SELECT key, value FROM settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}
