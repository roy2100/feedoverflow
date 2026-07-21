package jobs_test

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"rss-reader/server-go/internal/cache"
	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/feed"
	"rss-reader/server-go/internal/jobs"
	"rss-reader/server-go/internal/push"
	"rss-reader/server-go/internal/store"
)

// fakeNotifier records what the poller decided to push instead of talking to a
// push service.
type fakeNotifier struct {
	calls []notifyCall
}

type notifyCall struct {
	feedID   string
	feedName string
	arts     []store.NewArticle
	total    int
}

func (f *fakeNotifier) NotifyFeed(
	_ context.Context, feedID, feedName string, arts []store.NewArticle, total int,
) {
	f.calls = append(f.calls, notifyCall{feedID, feedName, arts, total})
}

// pollOnce runs one poll over a single feed whose fetch returns items.
func pollOnce(t *testing.T, handle *db.DB, n *fakeNotifier, items []feed.Item) {
	t.Helper()
	c := cache.New(handle, func(context.Context, string) (*feed.Parsed, error) {
		return &feed.Parsed{Title: "F", Items: items}, nil
	})
	r := &jobs.Runner{DB: handle, Cache: c, Log: quietLog(), CapBytes: 1 << 30, DBPath: "unused", Push: n}
	r.PollAllFeedsForTest(context.Background())
}

// oneFeedDB gives a DB with exactly one feed (the seeded starter feeds would each
// persist the same stub item and collide on article_id).
func oneFeedDB(t *testing.T) *db.DB {
	t.Helper()
	handle := newTestDB(t)
	if _, err := handle.Writer().Exec(`DELETE FROM feeds`); err != nil {
		t.Fatal(err)
	}
	seedFeed(t, handle.Writer(), "f1")
	return handle
}

func item(link, title string, pub time.Time) feed.Item {
	return feed.Item{
		Link: link, Title: title, Content: "body",
		PubDate: pub.Format(time.RFC1123Z),
	}
}

func watermark(t *testing.T, r *sql.DB) sql.NullInt64 {
	t.Helper()
	var ts sql.NullInt64
	if err := r.QueryRow(`SELECT last_notified_ts FROM feeds WHERE id = 'f1'`).Scan(&ts); err != nil {
		t.Fatal(err)
	}
	return ts
}

func TestPollDoesNotNotifyWhenPushDisabled(t *testing.T) {
	handle := oneFeedDB(t)
	n := &fakeNotifier{}
	pollOnce(t, handle, n, []feed.Item{item("https://x/1", "One", time.Now().Add(-time.Minute))})

	if len(n.calls) != 0 {
		t.Fatalf("push is off by default; got %d notifications", len(n.calls))
	}
}

// Enabling push seeds the watermark to that moment, so the feed's existing
// backlog is never replayed as a burst of notifications.
func TestPollDoesNotReplayBacklogAfterEnabling(t *testing.T) {
	handle := oneFeedDB(t)
	now := time.Now()
	backlog := []feed.Item{
		item("https://x/1", "Old one", now.Add(-48*time.Hour)),
		item("https://x/2", "Old two", now.Add(-24*time.Hour)),
	}
	if _, err := store.SetFeedPush(handle.Writer(), "f1", true, now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	n := &fakeNotifier{}
	pollOnce(t, handle, n, backlog)

	if len(n.calls) != 0 {
		t.Fatalf("backlog replayed: %+v", n.calls)
	}
}

func TestPollNotifiesNewArticles(t *testing.T) {
	handle := oneFeedDB(t)
	now := time.Now()
	// Watermark an hour back, so only the recent item counts as new.
	if _, err := store.SetFeedPush(
		handle.Writer(), "f1", true, now.Add(-time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	n := &fakeNotifier{}
	pollOnce(t, handle, n, []feed.Item{
		item("https://x/old", "Old", now.Add(-2*time.Hour)),
		item("https://x/new", "Fresh", now.Add(-time.Minute)),
	})

	if len(n.calls) != 1 {
		t.Fatalf("want 1 notification batch, got %d: %+v", len(n.calls), n.calls)
	}
	got := n.calls[0]
	if got.feedID != "f1" || got.total != 1 || len(got.arts) != 1 {
		t.Fatalf("batch: %+v", got)
	}
	if got.arts[0].Title != "Fresh" {
		t.Fatalf("notified the wrong article: %+v", got.arts[0])
	}

	// The watermark advanced past the notified article, so a second poll over the
	// same items is silent — this is what stops a 15-minute repeat loop.
	n2 := &fakeNotifier{}
	pollOnce(t, handle, n2, []feed.Item{
		item("https://x/old", "Old", now.Add(-2*time.Hour)),
		item("https://x/new", "Fresh", now.Add(-time.Minute)),
	})
	if len(n2.calls) != 0 {
		t.Fatalf("re-notified on the next poll: %+v", n2.calls)
	}
}

// More new articles than the per-feed cap: the poller hands the sender FetchLimit
// rows plus the true total, which is what the collapsed summary needs.
func TestPollCapsBatchButReportsTrueTotal(t *testing.T) {
	handle := oneFeedDB(t)
	now := time.Now()
	if _, err := store.SetFeedPush(
		handle.Writer(), "f1", true, now.Add(-time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	var items []feed.Item
	const fresh = 7
	for i := range fresh {
		items = append(items, item(
			"https://x/"+string(rune('a'+i)), "Item", now.Add(-time.Duration(i+1)*time.Minute)))
	}
	n := &fakeNotifier{}
	pollOnce(t, handle, n, items)

	if len(n.calls) != 1 {
		t.Fatalf("want 1 batch, got %d", len(n.calls))
	}
	if len(n.calls[0].arts) != push.FetchLimit {
		t.Fatalf("arts: got %d, want FetchLimit=%d", len(n.calls[0].arts), push.FetchLimit)
	}
	if n.calls[0].total != fresh {
		t.Fatalf("total: got %d, want %d", n.calls[0].total, fresh)
	}
}

// A feed whose watermark was never seeded (push enabled by an older build, or a
// row predating the column) starts its watermark at the current poll rather than
// notifying about everything already stored.
func TestPollSeedsMissingWatermarkInsteadOfNotifying(t *testing.T) {
	handle := oneFeedDB(t)
	if _, err := handle.Writer().Exec(
		`UPDATE feeds SET push_enabled = 1, last_notified_ts = NULL WHERE id = 'f1'`); err != nil {
		t.Fatal(err)
	}
	n := &fakeNotifier{}
	pollOnce(t, handle, n, []feed.Item{item("https://x/1", "One", time.Now().Add(-time.Hour))})

	if len(n.calls) != 0 {
		t.Fatalf("notified without a watermark: %+v", n.calls)
	}
	if ts := watermark(t, handle.Reader()); !ts.Valid {
		t.Fatal("watermark was not seeded")
	}
}
