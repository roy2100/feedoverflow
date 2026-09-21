package store

import (
	"database/sql"
	"time"
)

// ArticleAI is one on-demand LLM output for one article: its Chinese summary or
// the translation of its body.
//
// This is a side table, not columns on article_states, on purpose (CLAUDE.md:
// "on-demand from the reader, output in a side table — never a body-sized column
// here"). A translation is as large as the article, and article_states is the
// table every list query scans.
//
// SourceHash is the hash of the text the client sent — the body it was showing at
// the time, which may be the RSS content or the Readability 全文 (never persisted
// server-side, so the client is the only party that has it). A request whose text
// hashes the same is served from here; a different hash regenerates and replaces,
// which is what keeps a 全文 translation from being answered with the RSS one.
type ArticleAI struct {
	ArticleID  string
	Kind       string
	SourceHash string
	Model      string
	Content    string
	CreatedAt  int64 // epoch ms
}

// GetArticleAI returns the stored output for (article, kind), or nil when none.
func GetArticleAI(r *sql.DB, articleID, kind string) (*ArticleAI, error) {
	a := &ArticleAI{ArticleID: articleID, Kind: kind}
	err := r.QueryRow(
		`SELECT source_hash, model, content, created_at FROM article_ai
		  WHERE article_id = ? AND kind = ?`, articleID, kind).
		Scan(&a.SourceHash, &a.Model, &a.Content, &a.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return a, nil
}

// SaveArticleAI upserts one output. A re-run for the same (article, kind) replaces
// the row outright — there is exactly one current answer per kind.
func SaveArticleAI(w *sql.DB, a ArticleAI) error {
	if a.CreatedAt == 0 {
		a.CreatedAt = time.Now().UnixMilli()
	}
	_, err := w.Exec(
		`INSERT INTO article_ai (article_id, kind, source_hash, model, content, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(article_id, kind) DO UPDATE SET
		   source_hash = excluded.source_hash,
		   model       = excluded.model,
		   content     = excluded.content,
		   created_at  = excluded.created_at`,
		a.ArticleID, a.Kind, a.SourceHash, a.Model, a.Content, a.CreatedAt)
	return err
}

// ArticleExists reports whether article_states has the row — the guard that keeps
// POST /api/articles/:id/ai from minting AI output for an id nothing else knows.
func ArticleExists(r *sql.DB, articleID string) (bool, error) {
	var one int
	err := r.QueryRow(`SELECT 1 FROM article_states WHERE article_id = ?`, articleID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// PurgeOrphanAI drops outputs whose article is gone (feed deleted, size cap).
// article_ai carries no foreign key so a body-sized row can never block or slow
// an article delete; maintenance sweeps it instead.
func PurgeOrphanAI(w *sql.DB) (int64, error) {
	res, err := w.Exec(
		`DELETE FROM article_ai WHERE article_id NOT IN (SELECT article_id FROM article_states)`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
