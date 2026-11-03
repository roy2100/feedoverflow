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
const articleCols = `article_id, feed_id, feed_name, title, title_zh, link, pub_date,
	summary, content, author, audio_url, audio_duration, is_starred, content_updated_at`

// Same columns in the same scan order, but with `content` replaced by a literal —
// so scanArticleRows is shared and only the bytes change.
//
// Every list query uses this: the browser's list panes render neither the article
// body nor (by default) the summary, and RowToArticle is called with
// withContent=false, so the column was read and then thrown away. That read is not
// free. An article body is far larger than SQLite's page size, so it lives in
// overflow pages that the engine only walks when the column is actually
// referenced — naming it in the SELECT turned a ~40 kB response into tens of MB of
// page reads, invisible while the OS cache was warm and a ~450 ms stall on the
// first request after a restart. Content stays behind /api/articles/:id/content
// and the two reads that genuinely need it (Starred, ArticleByID).
const articleColsNoContent = `article_id, feed_id, feed_name, title, title_zh, link, pub_date,
	summary, '' AS content, author, audio_url, audio_duration, is_starred, content_updated_at`

func scanArticleRows(rows *sql.Rows) ([]articles.Row, error) {
	defer rows.Close()
	var out []articles.Row
	for rows.Next() {
		var r articles.Row
		if err := scanArticleRow(rows, &r); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// scanArticleRow scans the articleCols/articleColsNoContent columns into r,
// followed by any extra columns a caller selected after them.
func scanArticleRow(rows *sql.Rows, r *articles.Row, extra ...any) error {
	return rows.Scan(append([]any{
		&r.ArticleID, &r.FeedID, &r.FeedName, &r.Title, &r.TitleZh, &r.Link, &r.PubDate,
		&r.Summary, &r.Content, &r.Author, &r.AudioURL, &r.AudioDuration,
		&r.IsStarred, &r.ContentUpdatedAt,
	}, extra...)...)
}

// ListFeeds — GET /api/feeds: raw feed rows ordered by rowid (category omitted).
func ListFeeds(db *sql.DB) ([]model.Feed, error) {
	rows, err := db.Query(
		`SELECT id, name, url, last_fetched_at, COALESCE(push_enabled, 0) FROM feeds ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	feeds := []model.Feed{}
	for rows.Next() {
		var f model.Feed
		var last sql.NullInt64
		if err := rows.Scan(&f.ID, &f.Name, &f.URL, &last, &f.PushEnabled); err != nil {
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
		`SELECT `+articleColsNoContent+` FROM article_states ORDER BY pub_ts DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	return scanArticleRows(rows)
}

// SinceGlobal — today latest mode: global newest N since a pub_ts cutoff.
func SinceGlobal(db *sql.DB, since int64, limit int) ([]articles.Row, error) {
	rows, err := db.Query(
		`SELECT `+articleColsNoContent+` FROM article_states WHERE pub_ts >= ? ORDER BY pub_ts DESC LIMIT ?`,
		since, limit)
	if err != nil {
		return nil, err
	}
	return scanArticleRows(rows)
}

// ArticleByID fetches one article row — GET /api/articles/:id, which exists so a
// push notification can open its article directly. Every other list endpoint
// returns rows in bulk; this is the only by-id lookup. ok=false when no row
// matches (the article was trimmed by the size cap, or the id is stale).
func ArticleByID(db *sql.DB, id string) (articles.Row, bool, error) {
	rows, err := db.Query(
		`SELECT `+articleCols+` FROM article_states WHERE article_id = ?`, id)
	if err != nil {
		return articles.Row{}, false, err
	}
	out, err := scanArticleRows(rows)
	if err != nil || len(out) == 0 {
		return articles.Row{}, false, err
	}
	return out[0], true, nil
}

// NewestByFeed — digest mode: newest quota rows for one feed.
func NewestByFeed(db *sql.DB, feedID string, limit int) ([]articles.Row, error) {
	rows, err := db.Query(
		`SELECT `+articleColsNoContent+` FROM article_states WHERE feed_id = ? ORDER BY pub_ts DESC LIMIT ?`,
		feedID, limit)
	if err != nil {
		return nil, err
	}
	return scanArticleRows(rows)
}

// SinceByFeed — today digest mode: newest quota rows for one feed since a cutoff.
func SinceByFeed(db *sql.DB, feedID string, since int64, limit int) ([]articles.Row, error) {
	rows, err := db.Query(
		`SELECT `+articleColsNoContent+` FROM article_states
		 WHERE feed_id = ? AND pub_ts >= ? ORDER BY pub_ts DESC LIMIT ?`,
		feedID, since, limit)
	if err != nil {
		return nil, err
	}
	return scanArticleRows(rows)
}

// Starred — GET /api/starred: starred rows, newest-starred first. starred_at is
// non-NULL for every starred row (backfilled + set on star), so the partial index
// idx_article_states_starred serves this order index-only.
func Starred(db *sql.DB) ([]articles.Row, error) {
	rows, err := db.Query(
		`SELECT ` + articleCols + ` FROM article_states WHERE is_starred = 1 ORDER BY starred_at DESC`)
	if err != nil {
		return nil, err
	}
	return scanArticleRows(rows)
}

// Podcasts — GET /api/podcasts: audio-bearing rows, newest by pub_ts, cap 200.
func Podcasts(db *sql.DB) ([]articles.Row, error) {
	rows, err := db.Query(
		`SELECT ` + articleColsNoContent + ` FROM article_states
		 WHERE audio_url IS NOT NULL AND audio_url != ''
		 ORDER BY pub_ts DESC LIMIT 200`)
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

// likeEscaper escapes the LIKE metacharacters, matching q.replace(/[\\%_]/g,'\\$&').
// Backslash is escaped first; NewReplacer's single non-overlapping pass makes the
// order among the three safe.
var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// LikeEscape escapes a user-typed term for use inside a LIKE pattern (paired with
// ESCAPE '\'). Both search and collection rules feed raw input into LIKE, so the
// escaping lives here rather than being written twice.
func LikeEscape(s string) string { return likeEscaper.Replace(s) }

// SearchOpts narrows a search. Scope is "starred" | "feed" | "" (FeedID applies to
// "feed" only). Before (pub_ts, ms; 0 = none) keeps articles published strictly
// before it. AfterID != "" resumes after the row (AfterTs, AfterID) of a previous
// page — a keyset cursor, because pub_ts alone is not unique (date-only feeds
// share timestamps) and "older than the last row" would drop the rest of a tie.
type SearchOpts struct {
	Scope, FeedID string
	Before        int64
	AfterTs       int64
	AfterID       string
	Limit         int
}

// SearchHit is one matching row plus the pub_ts the next page's cursor needs.
type SearchHit struct {
	Row   articles.Row
	PubTs int64
}

// searchWhere is the WHERE clause shared by Search and SearchCount, without the
// cursor (a count spans every page).
func searchWhere(like string, o SearchOpts) (string, []any) {
	// title_zh is searched alongside title: when a feed has translation on, the
	// Chinese headline is what the list actually shows, so a query typed from what
	// is on screen has to match it.
	q := ` WHERE (title LIKE ? ESCAPE '\' OR title_zh LIKE ? ESCAPE '\'
		       OR summary LIKE ? ESCAPE '\' OR content LIKE ? ESCAPE '\')`
	args := []any{like, like, like, like}
	switch {
	case o.Scope == "starred":
		q += ` AND is_starred = 1`
	case o.Scope == "feed" && o.FeedID != "":
		q += ` AND feed_id = ?`
		args = append(args, o.FeedID)
	}
	if o.Before != 0 {
		q += ` AND pub_ts < ?`
		args = append(args, o.Before)
	}
	return q, args
}

// Search — GET /api/search: LIKE across title/title_zh/summary/content, newest
// first by (pub_ts, article_id) — one total order, so a cursor neither skips nor
// repeats a row. Ordering keys on the numeric pub_ts, never the raw text pub_date
// (not normalized in the DB). `like` is the already-escaped pattern (ESCAPE '\').
// A row with a NULL pub_ts sorts last and is never reached through a cursor; every
// write path sets it.
func Search(r *sql.DB, like string, o SearchOpts) ([]SearchHit, error) {
	where, args := searchWhere(like, o)
	if o.AfterID != "" {
		where += ` AND (pub_ts < ? OR (pub_ts = ? AND article_id < ?))`
		args = append(args, o.AfterTs, o.AfterTs, o.AfterID)
	}
	rows, err := r.Query(`SELECT `+articleColsNoContent+`, COALESCE(pub_ts, 0) FROM article_states`+
		where+` ORDER BY pub_ts DESC, article_id DESC LIMIT ?`, append(args, o.Limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SearchHit
	for rows.Next() {
		var h SearchHit
		if err := scanArticleRow(rows, &h.Row, &h.PubTs); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// SearchCount counts every match for like + scope + Before, ignoring the cursor and
// the limit. It reads every row's text (a page of a common term stops early), so
// callers ask for it explicitly.
func SearchCount(r *sql.DB, like string, o SearchOpts) (int, error) {
	where, args := searchWhere(like, o)
	var n int
	err := r.QueryRow(`SELECT count(*) FROM article_states`+where, args...).Scan(&n)
	return n, err
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
