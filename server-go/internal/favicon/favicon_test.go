package favicon_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/favicon"
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

func TestInvalidDomainNoFetch(t *testing.T) {
	var calls int32
	c := favicon.New(newTestDB(t), func(context.Context, string) ([]byte, string, error) {
		atomic.AddInt32(&calls, 1)
		return nil, "", nil
	})
	for _, d := range []string{"", "not a domain", "http://x.com", "localhost", "a..b.com"} {
		res, err := c.Get(context.Background(), d)
		if err != nil || res != nil {
			t.Errorf("invalid domain %q: res=%v err=%v (want nil,nil)", d, res, err)
		}
	}
	if calls != 0 {
		t.Errorf("invalid domains triggered %d fetches, want 0", calls)
	}
}

func TestCachesBlobAndServesFromCache(t *testing.T) {
	var calls int32
	c := favicon.New(newTestDB(t), func(context.Context, string) ([]byte, string, error) {
		atomic.AddInt32(&calls, 1)
		return []byte("PNGDATA"), "image/png", nil
	})
	// First call fetches + caches.
	res, err := c.Get(context.Background(), "example.com")
	if err != nil || res == nil || string(res.Image) != "PNGDATA" || res.ContentType != "image/png" {
		t.Fatalf("first get: res=%v err=%v", res, err)
	}
	// Second call served from cache (no new fetch).
	res, err = c.Get(context.Background(), "example.com")
	if err != nil || res == nil || string(res.Image) != "PNGDATA" {
		t.Fatalf("cached get: res=%v err=%v", res, err)
	}
	if calls != 1 {
		t.Errorf("expected 1 fetch (rest cached), got %d", calls)
	}
}

func TestNegativeCacheAndTTLRetry(t *testing.T) {
	var calls int32
	failing := func(context.Context, string) ([]byte, string, error) {
		atomic.AddInt32(&calls, 1)
		return nil, "", errors.New("upstream down")
	}
	handle := newTestDB(t)
	c := favicon.New(handle, failing)
	const t0 int64 = 1_700_000_000_000
	now := t0
	favicon.SetClock(c, func() int64 { return now })

	// Failure → nil result, negative cache written.
	if res, err := c.Get(context.Background(), "fail.example.com"); err != nil || res != nil {
		t.Fatalf("failing get: res=%v err=%v", res, err)
	}
	// Within negative TTL (< 1 day): no retry.
	now = t0 + 60*1000
	if res, _ := c.Get(context.Background(), "fail.example.com"); res != nil {
		t.Fatal("expected nil within negative TTL")
	}
	if calls != 1 {
		t.Fatalf("negative cache not honored: %d fetches, want 1", calls)
	}
	// After negative TTL (> 1 day): retry fires.
	now = t0 + 25*60*60*1000
	_, _ = c.Get(context.Background(), "fail.example.com")
	if calls != 2 {
		t.Fatalf("expected retry after negative TTL: %d fetches, want 2", calls)
	}
}

func TestEmptyBodyIsNegative(t *testing.T) {
	var calls int32
	c := favicon.New(newTestDB(t), func(context.Context, string) ([]byte, string, error) {
		atomic.AddInt32(&calls, 1)
		return []byte{}, "image/png", nil // empty body → treat as failure
	})
	if res, err := c.Get(context.Background(), "empty.example.com"); err != nil || res != nil {
		t.Fatalf("empty body: res=%v err=%v (want nil,nil)", res, err)
	}
	if calls != 1 {
		t.Errorf("expected 1 fetch, got %d", calls)
	}
}

func TestDefaultFaviconIsSVG(t *testing.T) {
	if favicon.DefaultContentType != "image/svg+xml" {
		t.Errorf("default content type: %q", favicon.DefaultContentType)
	}
	if len(favicon.DefaultFavicon) == 0 {
		t.Error("default favicon empty")
	}
}
