package store_test

import (
	"errors"
	"testing"

	"rss-reader/server-go/internal/store"
)

func TestGetFeed(t *testing.T) {
	h := newTestDB(t)
	insertFeed(t, h.Writer(), "f1", "Feed One", "http://f1", int64(42))

	f, ok, err := store.GetFeed(h.Reader(), "f1")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || f.Name != "Feed One" || f.URL != "http://f1" {
		t.Fatalf("GetFeed(f1): ok=%v %+v", ok, f)
	}
	if f.LastFetchedAt == nil || *f.LastFetchedAt != 42 {
		t.Fatalf("last_fetched_at: %+v", f.LastFetchedAt)
	}

	_, ok, err = store.GetFeed(h.Reader(), "missing")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("GetFeed(missing) ok=true, want false")
	}
}

func TestFeedURLExistsAndSet(t *testing.T) {
	h := newTestDB(t)
	insertFeed(t, h.Writer(), "f1", "A", "http://a", nil)
	insertFeed(t, h.Writer(), "f2", "B", "http://b", nil)

	yes, err := store.FeedURLExists(h.Reader(), "http://a")
	if err != nil {
		t.Fatal(err)
	}
	if !yes {
		t.Fatal("FeedURLExists(http://a) = false")
	}
	no, err := store.FeedURLExists(h.Reader(), "http://nope")
	if err != nil {
		t.Fatal(err)
	}
	if no {
		t.Fatal("FeedURLExists(http://nope) = true")
	}

	set, err := store.FeedURLSet(h.Reader())
	if err != nil {
		t.Fatal(err)
	}
	if !set["http://a"] || !set["http://b"] || len(set) != 2 {
		t.Fatalf("FeedURLSet: %#v", set)
	}
}

func TestIsUniqueViolation(t *testing.T) {
	if store.IsUniqueViolation(nil) {
		t.Fatal("nil should not be a unique violation")
	}
	if store.IsUniqueViolation(errors.New("some other error")) {
		t.Fatal("unrelated error misclassified")
	}
	if !store.IsUniqueViolation(errors.New("UNIQUE constraint failed: feeds.url")) {
		t.Fatal("UNIQUE constraint error not detected")
	}
}

func TestInsertFeedAndUniqueViolation(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	if err := store.InsertFeed(w, "f1", "A", "http://a"); err != nil {
		t.Fatal(err)
	}
	// Second add of the same URL trips idx_feeds_url.
	err := store.InsertFeed(w, "f2", "A dup", "http://a")
	if err == nil {
		t.Fatal("duplicate URL insert should fail")
	}
	if !store.IsUniqueViolation(err) {
		t.Fatalf("expected unique violation, got %v", err)
	}
}

func TestInsertFeedIgnore(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	if err := store.InsertFeedIgnore(w, "f1", "A", "http://a"); err != nil {
		t.Fatal(err)
	}
	// OR IGNORE: duplicate URL is a silent no-op, no second row.
	if err := store.InsertFeedIgnore(w, "f2", "dup", "http://a"); err != nil {
		t.Fatalf("INSERT OR IGNORE should not error on dup: %v", err)
	}
	feeds, err := store.ListFeeds(h.Reader())
	if err != nil {
		t.Fatal(err)
	}
	if len(feeds) != 1 || feeds[0].ID != "f1" {
		t.Fatalf("dup should be ignored: %+v", feeds)
	}
}

func TestRenameFeed(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	insertFeed(t, w, "f1", "Old", "http://a", nil)

	n, err := store.RenameFeed(w, "f1", "New")
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("RenameFeed rows = %d, want 1", n)
	}
	f, _, _ := store.GetFeed(h.Reader(), "f1")
	if f.Name != "New" {
		t.Fatalf("name not updated: %q", f.Name)
	}

	// RenameFeed is a plain UPDATE; rejecting empty names is the handler's job (see
	// TestFeedRenameEmpty in httpapi), so at the store level "" writes an empty
	// string — which the NOT NULL column accepts (only NULL is barred).
	if n, err := store.RenameFeed(w, "f1", ""); err != nil || n != 1 {
		t.Fatalf("RenameFeed empty: n=%d err=%v", n, err)
	}
	f, _, _ = store.GetFeed(h.Reader(), "f1")
	if f.Name != "" {
		t.Fatalf("empty rename should set empty string, got %q", f.Name)
	}

	// Not found -> 0 rows.
	n, err = store.RenameFeed(w, "ghost", "X")
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("RenameFeed(ghost) = %d, want 0", n)
	}
}

func TestDeleteFeedPurgesNonStarredKeepsStarred(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	insertFeed(t, w, "f1", "Feed", "http://f1", nil)
	insertArticle(t, w, af{id: "plain", feedID: "f1", link: "l1", isStarred: 0})
	insertArticle(t, w, af{id: "star", feedID: "f1", link: "l2", isStarred: 1})

	changes, err := store.DeleteFeed(w, "f1")
	if err != nil {
		t.Fatal(err)
	}
	if changes != 1 {
		t.Fatalf("DeleteFeed changes = %d, want 1", changes)
	}

	// Feed gone; non-starred purged; starred kept as an orphan.
	if _, ok, _ := store.GetFeed(h.Reader(), "f1"); ok {
		t.Fatal("feed row not deleted")
	}
	var plain, star int
	h.Reader().QueryRow(`SELECT COUNT(*) FROM article_states WHERE article_id = 'plain'`).Scan(&plain)
	h.Reader().QueryRow(`SELECT COUNT(*) FROM article_states WHERE article_id = 'star'`).Scan(&star)
	if plain != 0 {
		t.Fatal("non-starred article not purged")
	}
	if star != 1 {
		t.Fatal("starred article wrongly purged")
	}
}

func TestDeleteFeedNotFound(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	// A non-starred article on a non-existent feed must survive (Node skips the
	// article purge when no feed row matched).
	insertArticle(t, w, af{id: "keep", feedID: "ghost", link: "l1", isStarred: 0})
	changes, err := store.DeleteFeed(w, "ghost")
	if err != nil {
		t.Fatal(err)
	}
	if changes != 0 {
		t.Fatalf("DeleteFeed(ghost) changes = %d, want 0", changes)
	}
	var n int
	h.Reader().QueryRow(`SELECT COUNT(*) FROM article_states WHERE article_id = 'keep'`).Scan(&n)
	if n != 1 {
		t.Fatal("article purged despite no matching feed row")
	}
}

func TestAdoptStarredOrphans(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	// Kept starred orphan: feed gone, feed_url matches the re-added URL.
	insertArticle(t, w, af{id: "orphan", feedID: "gone", feedURL: "http://f", link: "l1", isStarred: 1})
	// Non-starred with matching url -> not adopted.
	insertArticle(t, w, af{id: "nonstar", feedID: "gone", feedURL: "http://f", link: "l2", isStarred: 0})
	// Starred but different url -> not adopted.
	insertArticle(t, w, af{id: "otherurl", feedID: "gone", feedURL: "http://other", link: "l3", isStarred: 1})

	// The re-added live feed claims the URL.
	insertFeed(t, w, "live", "少数派", "http://f", nil)

	n, err := store.AdoptStarredOrphans(w, "live", "少数派", "http://f")
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("adopted %d rows, want 1", n)
	}

	var feedID, feedName string
	if err := h.Reader().QueryRow(
		`SELECT feed_id, feed_name FROM article_states WHERE article_id = 'orphan'`).
		Scan(&feedID, &feedName); err != nil {
		t.Fatal(err)
	}
	if feedID != "live" || feedName != "少数派" {
		t.Fatalf("orphan not re-homed: feed_id=%q feed_name=%q", feedID, feedName)
	}
	// The excluded rows keep their old feed_id.
	var nonstarFeed string
	h.Reader().QueryRow(`SELECT feed_id FROM article_states WHERE article_id = 'nonstar'`).Scan(&nonstarFeed)
	if nonstarFeed != "gone" {
		t.Fatalf("non-starred row wrongly adopted: %q", nonstarFeed)
	}
}
