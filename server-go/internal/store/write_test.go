package store_test

import (
	"database/sql"
	"testing"

	"rss-reader/server-go/internal/feed"
	"rss-reader/server-go/internal/model"
	"rss-reader/server-go/internal/store"
)

// readState pulls the mutable columns SaveState/PersistItems touch, keyed by link.
type state struct {
	content          string
	audioURL         sql.NullString
	isStarred        sql.NullInt64
	feedURL          sql.NullString
	updatedAt        string
	contentUpdatedAt sql.NullInt64
}

func stateByLink(t *testing.T, r *sql.DB, link string) state {
	t.Helper()
	var s state
	err := r.QueryRow(
		`SELECT content, audio_url, is_starred, feed_url, updated_at, content_updated_at
		 FROM article_states WHERE link = ?`, link).
		Scan(&s.content, &s.audioURL, &s.isStarred, &s.feedURL, &s.updatedAt, &s.contentUpdatedAt)
	if err != nil {
		t.Fatalf("stateByLink %q: %v", link, err)
	}
	return s
}

func TestSaveStateInsertThenStarNeverClobbersContent(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	// feed_url is derived from feeds via subquery on insert.
	insertFeed(t, w, "f1", "Feed One", "http://f1.example/rss", nil)

	art := model.Article{
		ID: "id1", FeedID: "f1", FeedName: "Feed One",
		Title: "Original", Link: "http://f1.example/a", PubDate: "Mon, 02 Jan 2006 15:04:05 GMT",
		Summary: "sum", Content: "original body", Author: "me",
	}
	if err := store.SaveState(w, art, 1, 1_700_000_000_000); err != nil {
		t.Fatal(err)
	}
	got := stateByLink(t, h.Reader(), art.Link)
	if got.content != "original body" || got.isStarred.Int64 != 1 {
		t.Fatalf("insert: %+v", got)
	}
	if !got.feedURL.Valid || got.feedURL.String != "http://f1.example/rss" {
		t.Fatalf("feed_url not derived from feed: %+v", got.feedURL)
	}

	// Re-save with different content and star=0. The conflict branch must NOT
	// touch content (a star toggle can't clobber persisted body), but is_starred
	// flips because SaveState always passes a non-NULL value.
	art.Content = "TAMPERED"
	if err := store.SaveState(w, art, 0, 1_700_000_001_000); err != nil {
		t.Fatal(err)
	}
	got = stateByLink(t, h.Reader(), art.Link)
	if got.content != "original body" {
		t.Fatalf("content clobbered on re-save: %q", got.content)
	}
	if got.isStarred.Int64 != 0 {
		t.Fatalf("is_starred not updated: %d", got.isStarred.Int64)
	}
}

func TestSaveStateAudioCoalesce(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	insertFeed(t, w, "f1", "Feed One", "http://f1/rss", nil)
	art := model.Article{ID: "id1", FeedID: "f1", Link: "http://f1/a", Content: "c", AudioURL: "http://a/ep.mp3"}
	if err := store.SaveState(w, art, 0, 1); err != nil {
		t.Fatal(err)
	}
	// Re-save with empty audio: COALESCE(excluded.audio_url, audio_url) keeps it.
	art.AudioURL = ""
	if err := store.SaveState(w, art, 0, 2); err != nil {
		t.Fatal(err)
	}
	got := stateByLink(t, h.Reader(), art.Link)
	if !got.audioURL.Valid || got.audioURL.String != "http://a/ep.mp3" {
		t.Fatalf("audio_url should survive empty re-save: %+v", got.audioURL)
	}
}

func TestUpdateSettingInsertThenReplace(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	if err := store.UpdateSetting(w, "k", "v1"); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateSetting(w, "k", "v2"); err != nil {
		t.Fatal(err)
	}
	m, err := store.Settings(h.Reader())
	if err != nil {
		t.Fatal(err)
	}
	if m["k"] != "v2" {
		t.Fatalf("INSERT OR REPLACE failed: %q", m["k"])
	}
}

func TestClearFeedFreshness(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	insertFeed(t, w, "f1", "A", "http://a", int64(123))
	insertFeed(t, w, "f2", "B", "http://b", int64(456))
	if err := store.ClearFeedFreshness(w); err != nil {
		t.Fatal(err)
	}
	feeds, err := store.ListFeeds(h.Reader())
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range feeds {
		if f.LastFetchedAt != nil {
			t.Fatalf("feed %s freshness not cleared: %v", f.ID, *f.LastFetchedAt)
		}
	}
}

func mkItem(link, title, content string) feed.Item {
	return feed.Item{Link: link, Title: title, Content: content, PubDate: "Mon, 02 Jan 2006 15:04:05 GMT"}
}

func TestPersistItemsInsertsAllAndUpsertsOnChange(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	items := []feed.Item{
		mkItem("http://x/1", "One", "body one"),
		mkItem("http://x/2", "Two", "body two"),
	}
	if err := store.PersistItems(w, "f1", "Feed", "http://f1/rss", items, 1_000); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := h.Reader().QueryRow(`SELECT COUNT(*) FROM article_states`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("want 2 rows persisted, got %d", n)
	}
	// Fresh insert leaves content_updated_at NULL and is_starred 0.
	one := stateByLink(t, h.Reader(), "http://x/1")
	if one.contentUpdatedAt.Valid {
		t.Fatalf("content_updated_at should be NULL on insert: %+v", one.contentUpdatedAt)
	}
	if one.isStarred.Valid && one.isStarred.Int64 != 0 {
		t.Fatalf("is_starred should be 0 on insert: %+v", one.isStarred)
	}

	// Re-persist: item 1 changed, item 2 identical. Only the changed row's
	// content_updated_at is stamped (the WHERE guard skips the no-op).
	changed := []feed.Item{
		mkItem("http://x/1", "One EDITED", "body one v2"),
		mkItem("http://x/2", "Two", "body two"),
	}
	if err := store.PersistItems(w, "f1", "Feed", "http://f1/rss", changed, 2_000); err != nil {
		t.Fatal(err)
	}
	edited := stateByLink(t, h.Reader(), "http://x/1")
	if edited.content != "body one v2" {
		t.Fatalf("changed row not updated: %q", edited.content)
	}
	if !edited.contentUpdatedAt.Valid || edited.contentUpdatedAt.Int64 != 2_000 {
		t.Fatalf("content_updated_at not stamped on real edit: %+v", edited.contentUpdatedAt)
	}
	unchanged := stateByLink(t, h.Reader(), "http://x/2")
	if unchanged.contentUpdatedAt.Valid {
		t.Fatalf("no-op re-persist wrongly stamped content_updated_at: %+v", unchanged.contentUpdatedAt)
	}
}

func TestPersistItemsNoOpLeavesUpdatedAt(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	items := []feed.Item{mkItem("http://x/1", "One", "body")}
	if err := store.PersistItems(w, "f1", "Feed", "http://f1/rss", items, 1_000); err != nil {
		t.Fatal(err)
	}
	// Force a known-past updated_at, then re-persist the identical item.
	const sentinel = "2000-01-01 00:00:00"
	if _, err := w.Exec(`UPDATE article_states SET updated_at = ?`, sentinel); err != nil {
		t.Fatal(err)
	}
	if err := store.PersistItems(w, "f1", "Feed", "http://f1/rss", items, 2_000); err != nil {
		t.Fatal(err)
	}
	got := stateByLink(t, h.Reader(), "http://x/1")
	if got.updatedAt != sentinel {
		t.Fatalf("no-op re-persist bumped updated_at: %q", got.updatedAt)
	}
}

func TestRefreshPersistStampsLastFetched(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	insertFeed(t, w, "f1", "Feed", "http://f1/rss", nil)
	items := []feed.Item{mkItem("http://x/1", "One", "body")}
	if err := store.RefreshPersist(w, "f1", "Feed", "http://f1/rss", items, 9_999); err != nil {
		t.Fatal(err)
	}
	// Item persisted AND feed freshness stamped, atomically.
	var n int
	if err := h.Reader().QueryRow(
		`SELECT COUNT(*) FROM article_states WHERE feed_id = 'f1'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("want 1 persisted row, got %d", n)
	}
	feeds, err := store.ListFeeds(h.Reader())
	if err != nil {
		t.Fatal(err)
	}
	if len(feeds) != 1 || feeds[0].LastFetchedAt == nil || *feeds[0].LastFetchedAt != 9_999 {
		t.Fatalf("last_fetched_at not stamped: %+v", feeds)
	}
}
