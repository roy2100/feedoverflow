package store

import (
	"database/sql"

	"rss-reader/server-go/internal/articles"
)

// TrendHit is one article a trend term matched: the row the list renders plus the
// publish instant the handler buckets it by.
type TrendHit struct {
	Row   articles.Row
	PubTs int64
}

// TrendHits returns every article in [since, until] (pub_ts, ms) that mentions
// term, newest first. Matching is the collection keyword semantics, not search's:
// title + summary only, and a Latin-script term must match as a whole word (see
// wordBoundary) — the chart counts these rows, so a `museum` or a URL buried in an
// article body must not become a bar. Rationale: docs/plan-keyword-trend.md.
//
// One call per term, merged by the caller — the same static-SQL fan-out
// RuleArticles uses. There is no LIMIT: a count over a window has to see every row
// in it.
func TrendHits(r *sql.DB, term string, since, until int64) ([]TrendHit, error) {
	like := "%" + LikeEscape(term) + "%"
	rows, err := r.Query(`SELECT `+articleColsNoContent+`, pub_ts FROM article_states
		WHERE pub_ts >= ? AND pub_ts <= ?
		  AND (title LIKE ? ESCAPE '\' OR summary LIKE ? ESCAPE '\')
		ORDER BY pub_ts DESC`, since, until, like, like)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	re := wordBoundary(term)
	var out []TrendHit
	for rows.Next() {
		var h TrendHit
		if err := scanArticleRow(rows, &h.Row, &h.PubTs); err != nil {
			return nil, err
		}
		if re != nil && !matchesRow(h.Row, re) {
			continue
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// PubTimes returns the pub_ts of every article in [since, until] — the per-day
// denominator of a trend. Served from idx_article_states_pub alone; bucketing is
// left to the caller so matches and totals share one day function.
func PubTimes(r *sql.DB, since, until int64) ([]int64, error) {
	rows, err := r.Query(`SELECT pub_ts FROM article_states WHERE pub_ts >= ? AND pub_ts <= ?`, since, until)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var ts int64
		if err := rows.Scan(&ts); err != nil {
			return nil, err
		}
		out = append(out, ts)
	}
	return out, rows.Err()
}
