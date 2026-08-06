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

// TranslateConfig is the llm_config row: how to reach the endpoint (Conn) plus
// whether title translation is switched on.
//
// Conn stays a bare translate.Config so the client package knows nothing about
// policy — it is handed an endpoint, a key and a model, and that is all.
//
// There is no enable watermark: how far back switching on reaches is the same
// bound as how far back the worker keeps retrying (jobs.translateWindow), so a
// separate column could only ever hold the same value.
type TranslateConfig struct {
	Conn    translate.Config
	Enabled bool
}

// Active reports whether the worker should do anything: switched on *and*
// reachable. The two are separate because a key is a capability and the switch is
// an intent — the same split as the VAPID keypair versus a push opt-in.
func (c TranslateConfig) Active() bool {
	return c.Enabled && c.Conn.Ready()
}

// LLMConfig reads the single llm_config row. The row is seeded by InitSchema, so
// a missing one means a DB that predates the table — reported as an empty config,
// which simply leaves translation switched off.
func LLMConfig(r *sql.DB) (TranslateConfig, error) {
	var c TranslateConfig
	err := r.QueryRow(
		`SELECT base_url, api_key, model, COALESCE(enabled, 0) FROM llm_config WHERE id = 1`).
		Scan(&c.Conn.BaseURL, &c.Conn.APIKey, &c.Conn.Model, &c.Enabled)
	if err == sql.ErrNoRows {
		return TranslateConfig{}, nil
	}
	return c, err
}

// SaveLLMConfig applies a partial update. A nil field is left as stored — which is
// what lets the settings panel change the model without the browser ever having
// held the API key (GET never returns it, so it has nothing to echo back).
func SaveLLMConfig(w *sql.DB, baseURL, apiKey, model *string, enabled *bool) error {
	_, err := w.Exec(
		`UPDATE llm_config
		    SET base_url = COALESCE(?, base_url),
		        api_key  = COALESCE(?, api_key),
		        model    = COALESCE(?, model),
		        enabled  = COALESCE(?, enabled)
		  WHERE id = 1`,
		baseURL, apiKey, model, enabled)
	return err
}

// PendingTranslations returns untranslated titles published after `cutoff`
// (epoch ms), newest first.
//
// The cutoff is what makes this query bounded. `title_zh IS NULL` alone would
// match the entire historical table forever — every pre-existing row has it NULL
// — with no way to tell "not yet translated" from "never will be". Rows the
// worker settles are stamped ” rather than left NULL, so a title the model
// cannot handle drops out after one pass instead of being retried until it ages
// out. See jobs.translateWindow for what the cutoff means and why it is one value
// rather than two.
func PendingTranslations(r *sql.DB, cutoff int64, limit int) ([]PendingTitle, error) {
	rows, err := r.Query(`
		SELECT article_id, title
		  FROM article_states
		 WHERE title_zh IS NULL AND pub_ts > ?
		 ORDER BY pub_ts DESC LIMIT ?`, cutoff, limit)
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
