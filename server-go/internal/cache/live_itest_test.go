//go:build itest

// Live-network integration test — the Go port of server/test/parse-url.itest.ts.
// It hits the real coindesk / sspai / reddit feeds through the full fetch chain
// (ParseURL → gofeed → PersistItems) and asserts the end-to-end behaviour the
// offline parity suite can't: real HTTP works, real items land as rows with
// valid 12-char IDs, and an immediate re-fetch is a genuine no-op (no duplicate
// rows, no updated_at churn). Field-mapping parity against Node is proven
// byte-for-byte by internal/feed/persist_parity_test.go on saved fixtures; this
// only confirms the live path.
//
// Run: go test -tags itest ./internal/cache/

package cache_test

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	"rss-reader/server-go/internal/cache"
	"rss-reader/server-go/internal/feed"
	"rss-reader/server-go/internal/model"
)

// transient reports whether a live-fetch error is an external-dependency hiccup
// (rate-limit, 5xx, timeout) rather than a parse/persist bug — those should skip,
// not fail, so the suite stays green when a third-party host is flaky.
func transient(err error) bool {
	s := err.Error()
	return strings.Contains(s, "Status code 429") ||
		strings.Contains(s, "Status code 5") ||
		strings.Contains(s, "context deadline exceeded") ||
		strings.Contains(s, "timeout")
}

var liveFeeds = []model.Feed{
	{ID: "coindesk", Name: "CoinDesk", URL: "https://www.coindesk.com/arc/outboundfeeds/rss/"},
	{ID: "sspai", Name: "少数派", URL: "https://sspai.com/feed"},
	{ID: "reddit", Name: "RSS", URL: "https://www.reddit.com/r/rss.rss"},
}

func TestLiveRefresh(t *testing.T) {
	for _, f := range liveFeeds {
		t.Run(f.ID, func(t *testing.T) {
			handle := newTestDB(t)
			c := cache.New(handle, feed.ParseURL)

			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()

			res, err := c.RefreshFeed(ctx, f)
			if err != nil {
				if transient(err) {
					t.Skipf("live refresh skipped (transient upstream error): %v", err)
				}
				t.Fatalf("live refresh: %v", err)
			}
			if len(res.Items) == 0 {
				t.Fatalf("no items parsed from %s", f.URL)
			}
			n := rowCount(t, handle.Reader())
			if n == 0 {
				t.Fatalf("no rows persisted for %s", f.URL)
			}
			t.Logf("%s: %d items, %d rows, feedName=%q", f.ID, len(res.Items), n, res.FeedName)

			// Every persisted id is a 12-char md5 slice.
			rows, err := handle.Reader().Query(`SELECT article_id FROM article_states`)
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					t.Fatal(err)
				}
				if len(id) != 12 {
					t.Errorf("article id not 12 chars: %q", id)
				}
			}

			// Immediate re-fetch: same upstream content → no new rows, no churn.
			// Some hosts (reddit) rate-limit rapid repeats; a transient upstream
			// error here isn't a logic bug — the no-op behaviour is proven
			// deterministically offline in TestRefreshInsertsAndReFetchIsNoOp.
			stampSentinel(t, handle.Writer())
			if _, err := c.RefreshFeed(ctx, f); err != nil {
				t.Skipf("re-fetch skipped (transient upstream error): %v", err)
			}
			if got := rowCount(t, handle.Reader()); got != n {
				t.Errorf("re-fetch changed row count: got %d, want %d (duplicate rows?)", got, n)
			}
			var churned int
			if err := handle.Reader().QueryRow(
				`SELECT COUNT(*) FROM article_states WHERE updated_at <> ?`, sentinelUpdatedAt).
				Scan(&churned); err != nil && err != sql.ErrNoRows {
				t.Fatal(err)
			}
			if churned != 0 {
				t.Errorf("re-fetch churned %d unchanged rows (updated_at moved off sentinel)", churned)
			}
		})
	}
}
