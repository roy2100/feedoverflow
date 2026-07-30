package store_test

import (
	"database/sql"
	"testing"

	"rss-reader/server-go/internal/articles"
	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/feed"
	"rss-reader/server-go/internal/model"
	"rss-reader/server-go/internal/store"
)

func progressOf(t *testing.T, h *db.DB, id string) sql.NullInt64 {
	t.Helper()
	var pos sql.NullInt64
	if err := h.Reader().QueryRow(
		`SELECT play_position FROM article_states WHERE article_id = ?`, id).Scan(&pos); err != nil {
		t.Fatalf("play_position %q: %v", id, err)
	}
	return pos
}

// A playback position rides on the article row, so the two writers that share that
// row must leave it alone: neither a re-poll of the feed nor a star toggle may
// reset where the listener got to.
func TestPlaybackProgressSurvivesPersistAndStar(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	const feedURL = "http://p.example/rss"
	insertFeed(t, w, "f1", "Podcast", feedURL, nil)

	item := feed.Item{
		Link: "http://p.example/ep1", Title: "Episode",
		PubDate: "Mon, 02 Jan 2006 15:04:05 GMT", Summary: "sum", Content: "notes",
		EnclosureURL: "http://p.example/ep1.mp3", EnclosureType: "audio/mpeg",
	}
	if err := store.PersistItems(w, "f1", "Podcast", feedURL, []feed.Item{item}, 1_700_000_000_000); err != nil {
		t.Fatal(err)
	}
	id := articles.MakeID(item.Link, item.Title, item.PubDate)

	if err := store.SavePlaybackProgress(w, id, 630, 1_700_000_010_000); err != nil {
		t.Fatal(err)
	}

	// Star it: SaveState's conflict branch must not touch play_position.
	art := model.Article{
		ID: id, FeedID: "f1", FeedName: "Podcast", Title: item.Title,
		Link: item.Link, PubDate: item.PubDate, Content: item.Content,
	}
	if err := store.SaveState(w, art, 1, 1_700_000_100_000); err != nil {
		t.Fatal(err)
	}
	if got := progressOf(t, h, id); got.Int64 != 630 {
		t.Fatalf("star clobbered the position: got %v, want 630", got)
	}

	// Re-poll with edited content: the upsert rewrites the content columns only.
	edited := item
	edited.Content = "edited notes"
	if err := store.PersistItems(w, "f1", "Podcast", feedURL, []feed.Item{edited}, 1_700_000_200_000); err != nil {
		t.Fatal(err)
	}
	var content string
	if err := h.Reader().QueryRow(
		`SELECT content FROM article_states WHERE article_id = ?`, id).Scan(&content); err != nil {
		t.Fatal(err)
	}
	if content != "edited notes" {
		t.Fatalf("re-poll did not refresh content: %q", content)
	}
	if got := progressOf(t, h, id); got.Int64 != 630 {
		t.Fatalf("re-poll clobbered the position: got %v, want 630", got)
	}
}

func TestPlaybackProgressReadWriteClear(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	for i, id := range []string{"ep1", "ep2", "ep3"} {
		insertArticle(t, w, af{id: id, title: id, link: "http://p.example/" + id})
		if err := store.SavePlaybackProgress(w, id, 100*(i+1), 1_700_000_000_000+int64(i)); err != nil {
			t.Fatal(err)
		}
	}

	got, err := store.PlaybackProgress(h.Reader(), 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got["ep1"] != 100 || got["ep3"] != 300 {
		t.Fatalf("read back: %v", got)
	}

	// Newest-first ordering, so the limit keeps what was played most recently.
	one, err := store.PlaybackProgress(h.Reader(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(one) != 1 || one["ep3"] != 300 {
		t.Fatalf("limit 1: want only ep3, got %v", one)
	}

	if err := store.ClearPlaybackProgress(w, "ep2"); err != nil {
		t.Fatal(err)
	}
	got, err = store.PlaybackProgress(h.Reader(), 200)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := got["ep2"]; ok {
		t.Fatalf("ep2 still has a position: %v", got)
	}
	if len(got) != 2 {
		t.Fatalf("clear touched other rows: %v", got)
	}

	// Writing for an article that no longer exists is a silent no-op — it must not
	// bring a bare row into existence.
	if err := store.SavePlaybackProgress(w, "gone", 500, 1_700_000_999_000); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := h.Reader().QueryRow(
		`SELECT COUNT(*) FROM article_states WHERE article_id = 'gone'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("SavePlaybackProgress inserted an article row")
	}
}
