package store

import (
	"database/sql"

	"rss-reader/server-go/internal/dates"
	"rss-reader/server-go/internal/model"
)

// nullIfEmpty returns nil (SQL NULL) for "", mirroring Node's `x || null` so the
// COALESCE in the upsert keeps the existing column value when the field is empty.
func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// SaveState is the port of saveState/upsertState (articles.ts): insert-or-update
// keyed on article_id. On conflict it only touches audio_*, is_starred, and
// updated_at — never title/content/etc, so a star can't clobber persisted content.
// feed_url is derived from the live feed (insert-only). Runs on the write pool.
func SaveState(w *sql.DB, a model.Article, isStarred int, now int64) error {
	// Stamp the star-action time only when flipping to starred; leave it NULL on an
	// unstar so the ON CONFLICT below preserves any prior value. now is epoch ms.
	var starredAt any
	if isStarred == 1 {
		starredAt = now
	}
	_, err := w.Exec(
		`INSERT INTO article_states
		   (article_id,feed_id,feed_name,feed_url,title,link,pub_date,pub_ts,summary,content,author,audio_url,audio_duration,is_starred,starred_at)
		 VALUES (?,?,?,(SELECT url FROM feeds WHERE id = ?),?,?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT(article_id) DO UPDATE SET
		   audio_url      = COALESCE(excluded.audio_url, audio_url),
		   audio_duration = COALESCE(excluded.audio_duration, audio_duration),
		   is_starred = CASE WHEN excluded.is_starred IS NOT NULL THEN excluded.is_starred ELSE is_starred END,
		   starred_at = CASE WHEN excluded.is_starred = 1 THEN excluded.starred_at ELSE starred_at END,
		   updated_at = datetime('now')`,
		a.ID, a.FeedID, a.FeedName, a.FeedID, a.Title, a.Link, a.PubDate,
		dates.PubTs(a.PubDate, now), a.Summary, a.Content, a.Author,
		nullIfEmpty(a.AudioURL), nullIfEmpty(a.AudioDuration), isStarred, starredAt,
	)
	return err
}

// UpdateSetting upserts one settings key (INSERT OR REPLACE), matching the
// PATCH /api/settings loop.
func UpdateSetting(w *sql.DB, key, value string) error {
	_, err := w.Exec(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, key, value)
	return err
}

// ClearFeedFreshness nulls every feed's last_fetched_at so the next read
// re-fetches — the PATCH /api/settings side effect.
func ClearFeedFreshness(w *sql.DB) error {
	_, err := w.Exec(`UPDATE feeds SET last_fetched_at = NULL`)
	return err
}
