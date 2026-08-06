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
// whether title translation is switched on and how far back it reaches.
//
// Conn stays a bare translate.Config so the client package knows nothing about
// policy — it is handed an endpoint, a key and a model, and that is all.
type TranslateConfig struct {
	Conn    translate.Config
	Enabled bool
	// Since is the epoch-ms watermark stamped when the switch was turned on, and
	// never advanced afterwards. It bounds how far back enabling reaches; 0 means
	// unset (never enabled).
	Since int64
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
	var since sql.NullInt64
	err := r.QueryRow(
		`SELECT base_url, api_key, model, COALESCE(enabled, 0), translate_since
		   FROM llm_config WHERE id = 1`).
		Scan(&c.Conn.BaseURL, &c.Conn.APIKey, &c.Conn.Model, &c.Enabled, &since)
	if err == sql.ErrNoRows {
		return TranslateConfig{}, nil
	}
	c.Since = since.Int64
	return c, err
}

// SaveLLMConfig applies a partial update. A nil field is left as stored — which is
// what lets the settings panel change the model without the browser ever having
// held the API key (GET never returns it, so it has nothing to echo back).
//
// Switching `enabled` on stamps translate_since to `sinceOnEnable`; switching it
// off leaves the watermark alone, so it is re-stamped only on the next enable.
func SaveLLMConfig(w *sql.DB, baseURL, apiKey, model *string, enabled *bool, sinceOnEnable int64) error {
	if _, err := w.Exec(
		`UPDATE llm_config
		    SET base_url = COALESCE(?, base_url),
		        api_key  = COALESCE(?, api_key),
		        model    = COALESCE(?, model)
		  WHERE id = 1`,
		baseURL, apiKey, model); err != nil {
		return err
	}
	if enabled == nil {
		return nil
	}
	if !*enabled {
		_, err := w.Exec(`UPDATE llm_config SET enabled = 0 WHERE id = 1`)
		return err
	}
	// Stamp only on an actual off→on transition. Re-stamping is right after a spell
	// switched off — the articles published in the meantime were deliberately not
	// translated, and reaching back over them would undo that decision. But it must
	// not happen when the switch was already on: the settings form sends `enabled`
	// with every save, so an unrelated model edit would otherwise move the watermark
	// forward and silently skip everything published since it was turned on.
	_, err := w.Exec(`
		UPDATE llm_config
		   SET enabled = 1,
		       translate_since = CASE WHEN enabled = 1 THEN translate_since ELSE ? END
		 WHERE id = 1`, sinceOnEnable)
	return err
}

// PendingTranslations returns untranslated titles published after `cutoff`
// (epoch ms), newest first.
//
// The cutoff is what makes this query bounded, and it replaces a per-feed
// watermark column. `title_zh IS NULL` alone would match the entire historical
// table forever — every pre-existing row has it NULL — with no way to tell "not
// yet translated" from "never will be". Rows the worker settles are stamped ”
// rather than left NULL, so a title the model cannot handle drops out after one
// pass instead of being retried until it ages out.
//
// See the caller for how the cutoff is composed: it is the later of the enable
// watermark and a fixed recency bound, which are two different jobs (how far back
// enabling reaches, versus when to stop retrying).
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
