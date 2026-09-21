package store_test

import (
	"testing"

	"rss-reader/server-go/internal/store"
)

func TestArticleAIRoundTripAndReplace(t *testing.T) {
	handle := newTestDB(t)
	w, r := handle.Writer(), handle.Reader()
	if _, err := w.Exec(
		`INSERT INTO article_states (article_id, feed_id, title) VALUES ('a1', 'f', 'T')`); err != nil {
		t.Fatal(err)
	}

	if got, err := store.GetArticleAI(r, "a1", "summary"); err != nil || got != nil {
		t.Fatalf("empty table: got %+v, %v", got, err)
	}
	if err := store.SaveArticleAI(w, store.ArticleAI{
		ArticleID: "a1", Kind: "summary", SourceHash: "h1", Model: "m", Content: "一句话",
	}); err != nil {
		t.Fatal(err)
	}
	got, err := store.GetArticleAI(r, "a1", "summary")
	if err != nil || got == nil {
		t.Fatalf("read back: %+v, %v", got, err)
	}
	if got.SourceHash != "h1" || got.Content != "一句话" || got.Model != "m" || got.CreatedAt == 0 {
		t.Fatalf("row: %+v", got)
	}
	// Same (article, kind) again → replaced, not duplicated, not errored.
	if err := store.SaveArticleAI(w, store.ArticleAI{
		ArticleID: "a1", Kind: "summary", SourceHash: "h2", Model: "m", Content: "两句话",
	}); err != nil {
		t.Fatal(err)
	}
	got, _ = store.GetArticleAI(r, "a1", "summary")
	if got.SourceHash != "h2" || got.Content != "两句话" {
		t.Fatalf("replace: %+v", got)
	}
	// Kinds are independent rows.
	if got, _ := store.GetArticleAI(r, "a1", "translation"); got != nil {
		t.Fatalf("translation should be absent: %+v", got)
	}
	if ok, err := store.ArticleExists(r, "a1"); !ok || err != nil {
		t.Fatalf("exists: %v %v", ok, err)
	}
	if ok, err := store.ArticleExists(r, "nope"); ok || err != nil {
		t.Fatalf("missing: %v %v", ok, err)
	}
}

func TestPurgeOrphanAI(t *testing.T) {
	handle := newTestDB(t)
	w := handle.Writer()
	if _, err := w.Exec(
		`INSERT INTO article_states (article_id, feed_id, title) VALUES ('live', 'f', 'T')`); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"live", "gone"} {
		if err := store.SaveArticleAI(w, store.ArticleAI{
			ArticleID: id, Kind: "summary", SourceHash: "h", Model: "m", Content: "x",
		}); err != nil {
			t.Fatal(err)
		}
	}
	n, err := store.PurgeOrphanAI(w)
	if err != nil || n != 1 {
		t.Fatalf("purge: n=%d err=%v", n, err)
	}
	if got, _ := store.GetArticleAI(handle.Reader(), "live", "summary"); got == nil {
		t.Fatal("live row purged")
	}
	if got, _ := store.GetArticleAI(handle.Reader(), "gone", "summary"); got != nil {
		t.Fatal("orphan row kept")
	}
}
