package store

import (
	"database/sql"

	"rss-reader/server-go/internal/translate"
)

// PendingTitle is one row the translator worker is about to handle.
type PendingTitle struct {
	ArticleID string
	Title     string
}

// LLMConfig reads the single llm_config row. The row is seeded by InitSchema, so
// a missing one means a DB that predates the table — reported as an empty config,
// which simply leaves translation switched off.
func LLMConfig(r *sql.DB) (translate.Config, error) {
	var c translate.Config
	err := r.QueryRow(`SELECT base_url, api_key, model FROM llm_config WHERE id = 1`).
		Scan(&c.BaseURL, &c.APIKey, &c.Model)
	if err == sql.ErrNoRows {
		return translate.Config{}, nil
	}
	return c, err
}

// SaveLLMConfig applies a partial update. A nil field is left as stored — which is
// what lets the settings panel change the model without the browser ever having
// held the API key (GET never returns it, so it has nothing to echo back).
func SaveLLMConfig(w *sql.DB, baseURL, apiKey, model *string) error {
	_, err := w.Exec(
		`UPDATE llm_config
		    SET base_url = COALESCE(?, base_url),
		        api_key  = COALESCE(?, api_key),
		        model    = COALESCE(?, model)
		  WHERE id = 1`,
		baseURL, apiKey, model)
	return err
}

// SetFeedTranslate flips a feed's title-translation opt-in. Unlike SetFeedPush
// there is no watermark to seed: pending work is defined by a recency window, so
// switching on backfills that window and switching off simply stops new work.
// Already-stored translations are left alone either way. Returns the affected row
// count (0 = feed not found).
func SetFeedTranslate(w *sql.DB, id string, enabled bool) (int64, error) {
	v := 0
	if enabled {
		v = 1
	}
	res, err := w.Exec(`UPDATE feeds SET translate_enabled = ? WHERE id = ?`, v, id)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// PendingTranslations returns untranslated titles from translate-enabled feeds,
// newest first, published after `cutoff` (epoch ms).
//
// The recency window is what makes this query bounded, and it replaces a per-feed
// watermark column. `title_zh IS NULL` alone would match the entire historical
// table forever — every pre-existing row has it NULL — with no way to tell "not
// yet translated" from "never will be". The window fixes that with no stored
// state: enabling a feed backfills exactly the window, and the backlog is out of
// range by construction. Rows the worker settles are stamped ” rather than left
// NULL, so a title the model cannot handle drops out after one pass instead of
// being retried until it ages out.
func PendingTranslations(r *sql.DB, cutoff int64, limit int) ([]PendingTitle, error) {
	rows, err := r.Query(`
		SELECT a.article_id, a.title
		  FROM article_states a JOIN feeds f ON f.id = a.feed_id
		 WHERE f.translate_enabled = 1 AND a.title_zh IS NULL AND a.pub_ts > ?
		 ORDER BY a.pub_ts DESC LIMIT ?`, cutoff, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PendingTitle
	for rows.Next() {
		var p PendingTitle
		var title sql.NullString
		if err := rows.Scan(&p.ArticleID, &title); err != nil {
			return nil, err
		}
		p.Title = title.String
		out = append(out, p)
	}
	return out, rows.Err()
}

// SaveTranslation stores one title's result. An empty string is the "settled, no
// translation" sentinel (already Chinese, or nothing usable came back) — the
// difference from NULL is only visible to PendingTranslations.
func SaveTranslation(w *sql.DB, articleID, titleZh string) error {
	_, err := w.Exec(`UPDATE article_states SET title_zh = ? WHERE article_id = ?`, titleZh, articleID)
	return err
}
