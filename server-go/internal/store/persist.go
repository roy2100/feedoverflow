package store

import (
	"database/sql"
	"strconv"
	"strings"

	"rss-reader/server-go/internal/articles"
	"rss-reader/server-go/internal/dates"
	"rss-reader/server-go/internal/feed"
)

// upsertPolledArticleSQL mirrors upsertPolledArticle in server/articles.ts
// verbatim: insert a new item unstarred, or refresh a re-fetched item's content
// fields — but only when something actually changed (the WHERE guard), so
// unchanged rows aren't rewritten (no spurious updated_at churn). is_starred is
// never touched; feed_id/feed_name/feed_url are insert-only; content_updated_at is
// stamped whenever the update fires (content genuinely changed).
const upsertPolledArticleSQL = `
  INSERT INTO article_states
    (article_id,feed_id,feed_name,feed_url,title,link,pub_date,pub_ts,summary,content,author,audio_url,audio_duration,is_starred)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)
  ON CONFLICT(article_id) DO UPDATE SET
    title          = excluded.title,
    pub_date       = excluded.pub_date,
    pub_ts         = excluded.pub_ts,
    summary        = excluded.summary,
    content        = excluded.content,
    author         = excluded.author,
    audio_url      = COALESCE(excluded.audio_url, audio_url),
    audio_duration = COALESCE(excluded.audio_duration, audio_duration),
    updated_at     = datetime('now'),
    content_updated_at = ?
  WHERE title <> excluded.title
     OR summary <> excluded.summary
     OR content <> excluded.content
     OR author <> excluded.author
     OR pub_date <> excluded.pub_date`

// preparer is satisfied by both *sql.DB and *sql.Tx, so the upsert loop can run
// standalone or inside a caller's transaction.
type preparer interface {
	Prepare(query string) (*sql.Stmt, error)
}

// PersistItems is the port of enrich+persistItems (articles.ts): map each parsed
// item to its persisted shape and upsert them all in one transaction on the write
// pool. All items are persisted (no cap) so article_states stays a durable record.
func PersistItems(w *sql.DB, feedID, feedName, feedURL string, items []feed.Item, now int64) error {
	tx, err := w.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	if err := persistRows(tx, feedID, feedName, feedURL, items, now); err != nil {
		return err
	}
	return tx.Commit()
}

// RefreshPersist is the port of doRefresh's transaction (cache.ts): persist every
// fetched item AND stamp feeds.last_fetched_at, both in one transaction so a
// refresh commits atomically.
func RefreshPersist(w *sql.DB, feedID, feedName, feedURL string, items []feed.Item, now int64) error {
	tx, err := w.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	if err := persistRows(tx, feedID, feedName, feedURL, items, now); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE feeds SET last_fetched_at = ? WHERE id = ?`, now, feedID); err != nil {
		return err
	}
	return tx.Commit()
}

func persistRows(p preparer, feedID, feedName, feedURL string, items []feed.Item, now int64) error {
	stmt, err := p.Prepare(upsertPolledArticleSQL)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for i, it := range items {
		// enrich's id fallback: makeId(link, title, pubDate || isoDate || String(i)).
		pubForID := it.PubDate
		if pubForID == "" {
			pubForID = strconv.Itoa(i)
		}
		id := articles.MakeID(it.Link, it.Title, pubForID)

		title := it.Title
		if title == "" {
			title = "Untitled"
		}
		audioURL := ""
		if it.EnclosureURL != "" && strings.HasPrefix(it.EnclosureType, "audio") {
			audioURL = it.EnclosureURL
		}
		audioDuration := ""
		if audioURL != "" {
			audioDuration = articles.NormalizeDuration(it.ItunesDuration)
		}

		if _, err := stmt.Exec(
			id, feedID, feedName, feedURL, title, it.Link, it.PubDate,
			dates.PubTs(it.PubDate, now), it.Summary, it.Content, it.Author,
			nullIfEmpty(audioURL), nullIfEmpty(audioDuration), now,
		); err != nil {
			return err
		}
	}
	return nil
}
