package store

import (
	"database/sql"
	"strings"

	"rss-reader/server-go/internal/articles"
)

// A collection is a *saved query* over article_states, not a source: it owns no
// articles, fetches nothing, and deleting one removes zero article rows. Its
// contents are the union of its rules, each rule being
// `feed AND include AND NOT exclude` — see docs/plan-collections.md.

// Rule is one clause of a collection. Empty FeedID means "any feed"; empty
// Include means "no keyword requirement"; empty Exclude means "nothing excluded".
type Rule struct {
	FeedID  string `json:"feedId"`
	Include string `json:"include"`
	Exclude string `json:"exclude"`
}

// Collection is a named stream plus its rules.
type Collection struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Rules []Rule `json:"rules"`
}

// Normalized trims the rule's fields. Callers normalize before Valid so that a
// whitespace-only keyword counts as absent rather than as a filter matching
// every article that contains a space.
func (r Rule) Normalized() Rule {
	return Rule{
		FeedID:  strings.TrimSpace(r.FeedID),
		Include: strings.TrimSpace(r.Include),
		Exclude: strings.TrimSpace(r.Exclude),
	}
}

// Valid reports whether the rule constrains anything. A rule with neither a feed
// nor an include keyword selects the entire table — a slow duplicate of 全部 that
// is never what someone meant to build, so it is rejected rather than executed.
// Exclude alone does not count: "everything except X" is still a full scan.
func (r Rule) Valid() bool { return r.FeedID != "" || r.Include != "" }

// ListCollections returns every collection with its rules attached, in position
// order. One query per table, joined in memory — a single-user reader has a
// handful of collections, so this stays cheaper than deduping a JOIN's rows.
func ListCollections(db *sql.DB) ([]Collection, error) {
	rows, err := db.Query(`SELECT id, name FROM collections ORDER BY position, rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Collection{}
	index := map[string]int{}
	for rows.Next() {
		var c Collection
		if err := rows.Scan(&c.ID, &c.Name); err != nil {
			return nil, err
		}
		c.Rules = []Rule{}
		index[c.ID] = len(out)
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}

	rrows, err := db.Query(
		`SELECT collection_id, feed_id, include, exclude FROM collection_rules ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rrows.Close()
	for rrows.Next() {
		var cid string
		var feedID, include, exclude sql.NullString
		if err := rrows.Scan(&cid, &feedID, &include, &exclude); err != nil {
			return nil, err
		}
		i, ok := index[cid]
		if !ok {
			continue
		}
		out[i].Rules = append(out[i].Rules, Rule{
			FeedID:  feedID.String,
			Include: include.String,
			Exclude: exclude.String,
		})
	}
	return out, rrows.Err()
}

// GetCollection returns one collection with its rules; ok=false when absent.
func GetCollection(db *sql.DB, id string) (Collection, bool, error) {
	var c Collection
	err := db.QueryRow(`SELECT id, name FROM collections WHERE id = ?`, id).Scan(&c.ID, &c.Name)
	if err == sql.ErrNoRows {
		return Collection{}, false, nil
	}
	if err != nil {
		return Collection{}, false, err
	}
	c.Rules, err = collectionRules(db, id)
	if err != nil {
		return Collection{}, false, err
	}
	return c, true, nil
}

func collectionRules(db *sql.DB, id string) ([]Rule, error) {
	rows, err := db.Query(
		`SELECT feed_id, include, exclude FROM collection_rules WHERE collection_id = ? ORDER BY id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Rule{}
	for rows.Next() {
		var feedID, include, exclude sql.NullString
		if err := rows.Scan(&feedID, &include, &exclude); err != nil {
			return nil, err
		}
		out = append(out, Rule{
			FeedID:  feedID.String,
			Include: include.String,
			Exclude: exclude.String,
		})
	}
	return out, rows.Err()
}

// InsertCollection creates a collection and its rules in one transaction, placing
// it after the existing ones.
func InsertCollection(w *sql.DB, id, name string, rules []Rule, now int64) error {
	tx, err := w.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`INSERT INTO collections (id, name, position, created_at)
		 VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM collections), ?)`,
		id, name, now,
	); err != nil {
		return err
	}
	if err := insertRules(tx, id, rules); err != nil {
		return err
	}
	return tx.Commit()
}

// RenameCollection updates just the name, returning the affected row count so the
// handler can 404 on a missing id.
func RenameCollection(w *sql.DB, id, name string) (int64, error) {
	res, err := w.Exec(`UPDATE collections SET name = ? WHERE id = ?`, name, id)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ReplaceRules swaps a collection's whole rule set. Delete + insert runs inside a
// transaction so a failed edit can never leave the collection with a truncated
// set — a half-applied rule change silently narrows what the stream shows.
func ReplaceRules(w *sql.DB, id string, rules []Rule) error {
	tx, err := w.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM collection_rules WHERE collection_id = ?`, id); err != nil {
		return err
	}
	if err := insertRules(tx, id, rules); err != nil {
		return err
	}
	return tx.Commit()
}

func insertRules(tx *sql.Tx, id string, rules []Rule) error {
	for _, r := range rules {
		if _, err := tx.Exec(
			`INSERT INTO collection_rules (collection_id, feed_id, include, exclude) VALUES (?,?,?,?)`,
			id, nullIfEmpty(r.FeedID), nullIfEmpty(r.Include), nullIfEmpty(r.Exclude),
		); err != nil {
			return err
		}
	}
	return nil
}

// DeleteCollection removes the collection and its rules — and nothing else: the
// articles it selected are untouched. The rule delete is explicit rather than
// left to the declared ON DELETE CASCADE, because the connection DSN does not
// turn on `foreign_keys`, so that clause is documentation, not enforcement.
func DeleteCollection(w *sql.DB, id string) (int64, error) {
	tx, err := w.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM collection_rules WHERE collection_id = ?`, id); err != nil {
		return 0, err
	}
	res, err := tx.Exec(`DELETE FROM collections WHERE id = ?`, id)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return n, nil
}

// RuleArticles returns the newest `limit` rows matching one rule. The caller runs
// this per rule and merges, the same fan-out the digest list mode already uses —
// which keeps the SQL static instead of assembling one OR-chained WHERE per
// collection. Merging is exact, not an approximation: the newest N of a union is
// always contained in the union of the per-rule newest N.
//
// Keyword matching covers title and summary but deliberately not content: a term
// buried in an article's body is not what "this kind of article" means, and
// including content would make most rules match nearly everything from a feed.
func RuleArticles(r *sql.DB, rule Rule, limit int) ([]articles.Row, error) {
	q := `SELECT ` + articleCols + ` FROM article_states WHERE 1 = 1`
	args := []any{}
	if rule.FeedID != "" {
		q += ` AND feed_id = ?`
		args = append(args, rule.FeedID)
	}
	if rule.Include != "" {
		like := "%" + LikeEscape(rule.Include) + "%"
		q += ` AND (title LIKE ? ESCAPE '\' OR summary LIKE ? ESCAPE '\')`
		args = append(args, like, like)
	}
	if rule.Exclude != "" {
		like := "%" + LikeEscape(rule.Exclude) + "%"
		// COALESCE on both columns: `NULL NOT LIKE x` is NULL, which would drop every
		// row with an empty title or summary instead of keeping it.
		q += ` AND COALESCE(title, '') NOT LIKE ? ESCAPE '\'
		       AND COALESCE(summary, '') NOT LIKE ? ESCAPE '\'`
		args = append(args, like, like)
	}
	q += ` ORDER BY pub_ts DESC LIMIT ?`
	args = append(args, limit)

	rows, err := r.Query(q, args...)
	if err != nil {
		return nil, err
	}
	return scanArticleRows(rows)
}
