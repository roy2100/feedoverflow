package cache_test

import (
	"context"
	"database/sql"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"rss-reader/server-go/internal/cache"
	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/feed"
	"rss-reader/server-go/internal/model"
)

// newTestDB opens an isolated on-disk DB (mattn/go-sqlite3 needs a real path for
// the two-pool reader/writer split) with the production schema.
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

func mkParsed(title string, items ...feed.Item) *feed.Parsed {
	return &feed.Parsed{Title: title, Items: items}
}

func item(link, title, content string) feed.Item {
	return feed.Item{Link: link, Title: title, Content: content, PubDate: "Mon, 02 Jan 2006 15:04:05 GMT"}
}

const sentinelUpdatedAt = "2000-01-01 00:00:00"

// stampSentinel forces every row's updated_at to a known past value so a later
// no-op re-fetch (WHERE guard skips the UPDATE) leaves it untouched, while a real
// edit overwrites it via datetime('now').
func stampSentinel(t *testing.T, w *sql.DB) {
	t.Helper()
	if _, err := w.Exec(`UPDATE article_states SET updated_at = ?`, sentinelUpdatedAt); err != nil {
		t.Fatal(err)
	}
}

type rowMeta struct {
	updatedAt        string
	contentUpdatedAt sql.NullInt64
	content          string
}

func readRow(t *testing.T, r *sql.DB, id string) rowMeta {
	t.Helper()
	var m rowMeta
	err := r.QueryRow(
		`SELECT updated_at, content_updated_at, content FROM article_states WHERE article_id = ?`, id).
		Scan(&m.updatedAt, &m.contentUpdatedAt, &m.content)
	if err != nil {
		t.Fatalf("readRow %s: %v", id, err)
	}
	return m
}

func idOf(t *testing.T, r *sql.DB, link string) string {
	t.Helper()
	var id string
	if err := r.QueryRow(`SELECT article_id FROM article_states WHERE link = ?`, link).Scan(&id); err != nil {
		t.Fatalf("idOf %s: %v", link, err)
	}
	return id
}

func rowCount(t *testing.T, r *sql.DB) int {
	t.Helper()
	var n int
	if err := r.QueryRow(`SELECT COUNT(*) FROM article_states`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// fixedFetch returns a FetchFunc serving a static Parsed and counting calls.
func fixedFetch(parsed *feed.Parsed, calls *int32) cache.FetchFunc {
	return func(ctx context.Context, url string) (*feed.Parsed, error) {
		if calls != nil {
			atomic.AddInt32(calls, 1)
		}
		return parsed, nil
	}
}

// TestRefreshInsertsAndReFetchIsNoOp is the Phase-6 Verify core: a refresh inserts
// items; an immediate re-fetch of the SAME content changes nothing (no updated_at
// churn, content_updated_at stays NULL — the WHERE guard skips the UPDATE).
func TestRefreshInsertsAndReFetchIsNoOp(t *testing.T) {
	handle := newTestDB(t)
	parsed := mkParsed("Feed", item("https://x/1", "One", "body one"), item("https://x/2", "Two", "body two"))

	var calls int32
	c := cache.New(handle, fixedFetch(parsed, &calls))
	f := model.Feed{ID: "f1", Name: "Feed", URL: "https://x/feed"}

	if _, err := c.RefreshFeed(context.Background(), f); err != nil {
		t.Fatalf("first refresh: %v", err)
	}
	if got := rowCount(t, handle.Reader()); got != 2 {
		t.Fatalf("row count after insert: got %d, want 2", got)
	}
	id1 := idOf(t, handle.Reader(), "https://x/1")
	if len(id1) != 12 {
		t.Fatalf("article id not 12 chars: %q", id1)
	}
	before := readRow(t, handle.Reader(), id1)
	if before.contentUpdatedAt.Valid {
		t.Errorf("content_updated_at should be NULL on fresh insert, got %d", before.contentUpdatedAt.Int64)
	}

	stampSentinel(t, handle.Writer())

	// Immediate re-fetch: identical items → the guarded upsert must not fire.
	if _, err := c.RefreshFeed(context.Background(), f); err != nil {
		t.Fatalf("second refresh: %v", err)
	}
	after := readRow(t, handle.Reader(), id1)
	if after.updatedAt != sentinelUpdatedAt {
		t.Errorf("updated_at churned on no-op re-fetch: got %q, want sentinel", after.updatedAt)
	}
	if after.contentUpdatedAt.Valid {
		t.Errorf("content_updated_at stamped on no-op re-fetch: %d", after.contentUpdatedAt.Int64)
	}
	if got := rowCount(t, handle.Reader()); got != 2 {
		t.Errorf("re-fetch created duplicate rows: got %d, want 2", got)
	}
}

// TestContentEditStampsContentUpdatedAt: a genuine upstream content change fires
// the guarded UPDATE — content_updated_at is stamped (to the refresh clock) and
// updated_at moves off the sentinel; unchanged siblings stay untouched.
func TestContentEditStampsContentUpdatedAt(t *testing.T) {
	handle := newTestDB(t)
	first := mkParsed("Feed", item("https://x/1", "One", "body one"), item("https://x/2", "Two", "body two"))

	c := cache.New(handle, fixedFetch(first, nil))
	// Pin the clock so the stamped content_updated_at is predictable.
	const fixedNow int64 = 1_700_000_000_000
	cache.SetClock(c, func() int64 { return fixedNow })
	f := model.Feed{ID: "f1", Name: "Feed", URL: "https://x/feed"}

	if _, err := c.RefreshFeed(context.Background(), f); err != nil {
		t.Fatalf("first refresh: %v", err)
	}
	id1 := idOf(t, handle.Reader(), "https://x/1")
	id2 := idOf(t, handle.Reader(), "https://x/2")
	stampSentinel(t, handle.Writer())

	// Edit item 1's content only.
	edited := mkParsed("Feed", item("https://x/1", "One", "body one EDITED"), item("https://x/2", "Two", "body two"))
	cache.SetFetch(c, fixedFetch(edited, nil))
	if _, err := c.RefreshFeed(context.Background(), f); err != nil {
		t.Fatalf("edit refresh: %v", err)
	}

	edR := readRow(t, handle.Reader(), id1)
	if edR.content != "body one EDITED" {
		t.Errorf("content not updated: got %q", edR.content)
	}
	if !edR.contentUpdatedAt.Valid || edR.contentUpdatedAt.Int64 != fixedNow {
		t.Errorf("content_updated_at not stamped to clock: valid=%v val=%d want %d",
			edR.contentUpdatedAt.Valid, edR.contentUpdatedAt.Int64, fixedNow)
	}
	if edR.updatedAt == sentinelUpdatedAt {
		t.Errorf("updated_at did not move on real edit")
	}

	unchanged := readRow(t, handle.Reader(), id2)
	if unchanged.updatedAt != sentinelUpdatedAt {
		t.Errorf("unchanged sibling churned: updated_at=%q", unchanged.updatedAt)
	}
	if unchanged.contentUpdatedAt.Valid {
		t.Errorf("unchanged sibling got content_updated_at: %d", unchanged.contentUpdatedAt.Int64)
	}
}

// TestSingleFlight: concurrent refreshes of one feed share a single fetch.
func TestSingleFlight(t *testing.T) {
	handle := newTestDB(t)
	parsed := mkParsed("Feed", item("https://x/1", "One", "body"))

	release := make(chan struct{})
	var calls int32
	blocking := func(ctx context.Context, url string) (*feed.Parsed, error) {
		atomic.AddInt32(&calls, 1)
		<-release
		return parsed, nil
	}
	c := cache.New(handle, blocking)
	f := model.Feed{ID: "f1", Name: "Feed", URL: "https://x/feed"}

	const callers = 5
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = c.RefreshFeed(context.Background(), f)
		}()
	}
	// Wait until the other callers have actually coalesced onto the leader's
	// flight. A mere non-empty inflight map is not enough: it only proves the
	// leader registered, and releasing there lets it finish and clear the entry
	// before the stragglers arrive — each then starts its own fetch and the test
	// fails with "fetch called 5 times". This terminates because the leader is
	// parked in fetch until release, so its flight cannot disappear underneath.
	for c.InflightJoined(f.ID) < callers-1 {
		runtime.Gosched()
	}
	close(release)
	wg.Wait()

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("single-flight broken: fetch called %d times, want 1", got)
	}
}

// TestEnsureFreshFreshNoOp: a feed fetched within the TTL triggers no fetch.
func TestEnsureFreshFreshNoOp(t *testing.T) {
	handle := newTestDB(t)
	var calls int32
	c := cache.New(handle, fixedFetch(mkParsed("Feed"), &calls))
	const now int64 = 1_700_000_000_000
	cache.SetClock(c, func() int64 { return now })

	last := now - 1000 // 1s ago, well within 5-min TTL
	f := model.Feed{ID: "f1", Name: "Feed", URL: "https://x/feed", LastFetchedAt: &last}
	if err := c.EnsureFresh(context.Background(), f); err != nil {
		t.Fatalf("EnsureFresh: %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 0 {
		t.Errorf("fresh feed fetched: %d calls, want 0", got)
	}
}

// TestEnsureFreshNewFeedAwaits: a brand-new feed (never fetched, no rows) blocks
// on one fetch so the first load returns content.
func TestEnsureFreshNewFeedAwaits(t *testing.T) {
	handle := newTestDB(t)
	var calls int32
	parsed := mkParsed("Feed", item("https://x/1", "One", "body"))
	c := cache.New(handle, fixedFetch(parsed, &calls))

	f := model.Feed{ID: "f1", Name: "Feed", URL: "https://x/feed"} // LastFetchedAt nil
	if err := c.EnsureFresh(context.Background(), f); err != nil {
		t.Fatalf("EnsureFresh: %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("new feed not fetched synchronously: %d calls, want 1", got)
	}
	if got := rowCount(t, handle.Reader()); got != 1 {
		t.Errorf("new feed rows not persisted: got %d, want 1", got)
	}
}

// TestStartCacheWarming: never-fetched feeds are warmed up front and gate Ready();
// once they settle Ready() flips true. Uses an injected fetch (no network).
func TestStartCacheWarming(t *testing.T) {
	handle := newTestDB(t)
	// Replace the seeded starter feeds with two uncached (last_fetched_at NULL) feeds.
	if _, err := handle.Writer().Exec(`DELETE FROM feeds`); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"w1", "w2"} {
		if _, err := handle.Writer().Exec(
			`INSERT INTO feeds (id, name, url) VALUES (?, 'F', ?)`, id, "https://f/"+id); err != nil {
			t.Fatal(err)
		}
	}
	var calls int32
	c := cache.New(handle, func(_ context.Context, url string) (*feed.Parsed, error) {
		atomic.AddInt32(&calls, 1)
		// Unique link per feed so both persist (feed_id is insert-only).
		return &feed.Parsed{Title: "F", Items: []feed.Item{
			{Link: url + "#1", Title: "One", Content: "b", PubDate: "Fri, 05 Jun 2026 00:00:00 GMT"},
		}}, nil
	})

	if c.Ready() {
		t.Fatal("Ready() should be false before warming completes")
	}
	if err := c.StartCacheWarming(); err != nil {
		t.Fatalf("StartCacheWarming: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for !c.Ready() {
		if time.Now().After(deadline) {
			t.Fatal("warming did not flip Ready() within 5s")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Errorf("warmed %d feeds, want 2", got)
	}
	var rows int
	_ = handle.Reader().QueryRow(`SELECT COUNT(*) FROM article_states`).Scan(&rows)
	if rows != 2 {
		t.Errorf("warming persisted %d rows, want 2", rows)
	}
}
