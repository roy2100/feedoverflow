package jobs_test

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"rss-reader/server-go/internal/cache"
	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/feed"
	"rss-reader/server-go/internal/jobs"
)

func newTestDB(t *testing.T) *db.DB {
	t.Helper()
	handle, err := db.OpenHandle(t.TempDir() + "/t.db")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := db.InitSchema(handle.Writer()); err != nil {
		t.Fatalf("schema: %v", err)
	}
	t.Cleanup(func() { handle.Close() })
	return handle
}

func quietLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(newDiscard(), &slog.HandlerOptions{Level: slog.LevelError}))
}

type discard struct{}

func newDiscard() *discard                   { return &discard{} }
func (*discard) Write(p []byte) (int, error) { return len(p), nil }

func seedArticle(t *testing.T, w *sql.DB, id, feedID, pubDate, content string, starred int) {
	t.Helper()
	_, err := w.Exec(
		`INSERT INTO article_states (article_id, feed_id, feed_name, title, link, pub_date, content, summary, is_starred, updated_at)
		 VALUES (?, ?, 'F', 'T', ?, ?, ?, '', ?, datetime('now'))`,
		id, feedID, "https://x/"+id, pubDate, content, starred)
	if err != nil {
		t.Fatalf("seed %s: %v", id, err)
	}
}

func seedFeed(t *testing.T, w *sql.DB, id string) {
	t.Helper()
	if _, err := w.Exec(`INSERT INTO feeds (id, name, url) VALUES (?, 'F', ?)`, id, "https://f/"+id); err != nil {
		t.Fatalf("seed feed: %v", err)
	}
}

func count(t *testing.T, r *sql.DB, where string) int {
	t.Helper()
	var n int
	if err := r.QueryRow(`SELECT COUNT(*) FROM article_states WHERE ` + where).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func dbSize(t *testing.T, w *sql.DB) int64 {
	t.Helper()
	var pc, ps int64
	if err := w.QueryRow(`PRAGMA page_count`).Scan(&pc); err != nil {
		t.Fatal(err)
	}
	if err := w.QueryRow(`PRAGMA page_size`).Scan(&ps); err != nil {
		t.Fatal(err)
	}
	return pc * ps
}

func TestCleanupOrphans(t *testing.T) {
	handle := newTestDB(t)
	w := handle.Writer()
	seedFeed(t, w, "live")
	seedArticle(t, w, "a1", "live", "Fri, 05 Jun 2026 00:00:00 GMT", "x", 0)         // live feed → kept
	seedArticle(t, w, "orphan", "gone", "Fri, 05 Jun 2026 00:00:00 GMT", "x", 0)     // non-starred orphan → deleted
	seedArticle(t, w, "starOrphan", "gone", "Fri, 05 Jun 2026 00:00:00 GMT", "x", 1) // starred orphan → kept

	n, err := jobs.CleanupOrphans(w, quietLog())
	if err != nil {
		t.Fatalf("CleanupOrphans: %v", err)
	}
	if n != 1 {
		t.Errorf("deleted %d, want 1", n)
	}
	if count(t, handle.Reader(), "article_id='orphan'") != 0 {
		t.Error("non-starred orphan not deleted")
	}
	if count(t, handle.Reader(), "article_id='starOrphan'") != 1 {
		t.Error("starred orphan wrongly deleted")
	}
	if count(t, handle.Reader(), "article_id='a1'") != 1 {
		t.Error("live-feed article wrongly deleted")
	}
}

func TestEnforceSizeCapTrimsAndKeepsStarred(t *testing.T) {
	handle := newTestDB(t)
	w := handle.Writer()
	big := strings.Repeat("x", 8*1024) // ~8 KB per row

	// 150 non-starred rows with ascending pub dates (n000 oldest) + 5 starred.
	for i := 0; i < 150; i++ {
		pub := fmt.Sprintf("%02d Jun 2026 00:00:00 GMT", (i%28)+1)
		seedArticle(t, w, fmt.Sprintf("n%03d", i), "live", pub, big, 0)
	}
	for i := 0; i < 5; i++ {
		seedArticle(t, w, fmt.Sprintf("s%03d", i), "live", "01 Jan 2020 00:00:00 GMT", big, 1)
	}

	sizeBefore := dbSize(t, w)
	cap := sizeBefore * 6 / 10 // force over-cap

	deleted, err := jobs.EnforceSizeCap(handle, cap, quietLog())
	if err != nil {
		t.Fatalf("EnforceSizeCap: %v", err)
	}
	if deleted == 0 {
		t.Fatal("expected some rows deleted")
	}
	sizeAfter := dbSize(t, w)
	if sizeAfter > cap {
		t.Errorf("size not trimmed under cap: after=%d cap=%d before=%d", sizeAfter, cap, sizeBefore)
	}
	// Starred rows never deleted.
	if got := count(t, handle.Reader(), "is_starred=1"); got != 5 {
		t.Errorf("starred rows deleted: %d remain, want 5", got)
	}
	// Oldest non-starred deleted first: n000 (pub day 01) gone before n004 (day 05).
	if count(t, handle.Reader(), "article_id='n000'") != 0 {
		t.Error("oldest non-starred row should have been deleted first")
	}
}

func TestEnforceSizeCapNoOpUnderCap(t *testing.T) {
	handle := newTestDB(t)
	seedArticle(t, handle.Writer(), "a", "live", "01 Jun 2026 00:00:00 GMT", "small", 0)
	deleted, err := jobs.EnforceSizeCap(handle, 1<<30, quietLog()) // 1 GB cap
	if err != nil || deleted != 0 {
		t.Fatalf("under-cap: deleted=%d err=%v (want 0,nil)", deleted, err)
	}
}

func TestCheckpointWAL(t *testing.T) {
	handle := newTestDB(t)
	seedArticle(t, handle.Writer(), "a", "live", "01 Jun 2026 00:00:00 GMT", "x", 0)
	// Should not panic/error; on an idle test DB it truncates cleanly.
	jobs.CheckpointWAL(handle.Writer(), quietLog())
}

func TestPollAllFeedsPersists(t *testing.T) {
	handle := newTestDB(t)
	// InitSchema seeds 4 starter feeds; drop them so this test has exactly one feed
	// (no inter-feed stagger, no article_id collision from the shared stub item).
	if _, err := handle.Writer().Exec(`DELETE FROM feeds`); err != nil {
		t.Fatal(err)
	}
	seedFeed(t, handle.Writer(), "f1")

	items := []feed.Item{{Link: "https://x/1", Title: "One", Content: "body", PubDate: "Fri, 05 Jun 2026 00:00:00 GMT"}}
	c := cache.New(handle, func(context.Context, string) (*feed.Parsed, error) {
		return &feed.Parsed{Title: "F", Items: items}, nil
	})
	r := &jobs.Runner{DB: handle, Cache: c, Log: quietLog(), CapBytes: 1 << 30, DBPath: "unused"}

	r.PollAllFeedsForTest(context.Background())

	if count(t, handle.Reader(), "feed_id='f1'") != 1 {
		t.Error("poll did not persist the feed's item")
	}
}

func TestResourceSampleLogged(t *testing.T) {
	var buf strings.Builder
	log := slog.New(slog.NewTextHandler(&buf, nil))
	r := &jobs.Runner{DB: newTestDB(t), Log: log, DBPath: "unused"}

	ctx, cancel := context.WithCancel(context.Background())
	r.StartResourceMonitor(ctx) // logs the boot sample synchronously
	cancel()

	if !strings.Contains(buf.String(), "resource sample") {
		t.Errorf("no resource sample logged: %q", buf.String())
	}
}
