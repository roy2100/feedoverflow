// Package cache is the Go port of server/cache.ts: the single fetch chain
// (parse upstream → persist every item into article_states → stamp
// feeds.last_fetched_at) plus the two guards that wrap every fetch path —
// single-flight dedup per feed and a REFRESH_CONCURRENCY slot cap — and the TTL
// scheduler (ensureFresh) callers use before serving a feed's rows.
package cache

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"rss-reader/server-go/internal/crash"
	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/feed"
	"rss-reader/server-go/internal/model"
	"rss-reader/server-go/internal/store"
)

// CacheTTL mirrors CACHE_TTL: a feed fetched within this window is fresh.
const CacheTTL = 5 * time.Minute

// defaultRefreshConcurrency is the fallback REFRESH_CONCURRENCY: at most this many
// refreshes do their fetch+persist work at once, so a page-load / startup / poll
// fan-out can't bunch every feed's persist together. main.go overrides it from
// config via WithConcurrency.
const defaultRefreshConcurrency = 6

// Result is the port of RefreshResult: the parsed items plus the resolved feed
// name (parsed.title || feed.name).
type Result struct {
	Items    []feed.Item
	FeedName string
}

// FetchFunc fetches and parses a feed URL. Injectable so tests can avoid the
// network; production wires feed.ParseURL.
type FetchFunc func(ctx context.Context, url string) (*feed.Parsed, error)

// Cache owns the fetch scheduler state. Unlike the Node module globals it is a
// value so tests get an isolated scheduler + DB.
type Cache struct {
	db    *db.DB
	fetch FetchFunc

	mu       sync.Mutex
	inflight map[string]*flight
	sem      chan struct{} // buffered to refreshConcurrency

	readyMu sync.Mutex
	ready   bool

	// now is the clock (epoch ms); overridable in tests. Defaults to real time.
	now func() int64
}

type flight struct {
	done chan struct{}
	res  Result
	err  error
}

// Option customizes a Cache at construction. Unset options keep the defaults.
type Option func(*Cache)

// WithConcurrency overrides the fetch+persist slot cap (REFRESH_CONCURRENCY).
// n < 1 is ignored so a misconfigured value keeps the default.
func WithConcurrency(n int) Option {
	return func(c *Cache) {
		if n >= 1 {
			c.sem = make(chan struct{}, n)
		}
	}
}

// New builds a Cache over a DB handle. Pass nil fetch to use feed.ParseURL.
func New(handle *db.DB, fetch FetchFunc, opts ...Option) *Cache {
	if fetch == nil {
		fetch = feed.ParseURL
	}
	c := &Cache{
		db:       handle,
		fetch:    fetch,
		inflight: map[string]*flight{},
		sem:      make(chan struct{}, defaultRefreshConcurrency),
		now:      func() int64 { return time.Now().UnixMilli() },
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// RefreshFeed is the single-flight wrapper (port of refreshFeed): concurrent
// callers for the same feed share one in-flight refresh; the entry is cleared on
// settle. Every fetch path (ensureFresh, poller, startup warming) funnels here.
func (c *Cache) RefreshFeed(ctx context.Context, f model.Feed) (Result, error) {
	c.mu.Lock()
	if fl, ok := c.inflight[f.ID]; ok {
		c.mu.Unlock()
		<-fl.done
		return fl.res, fl.err
	}
	fl := &flight{done: make(chan struct{})}
	c.inflight[f.ID] = fl
	c.mu.Unlock()

	fl.res, fl.err = c.doRefresh(ctx, f)

	c.mu.Lock()
	delete(c.inflight, f.ID)
	c.mu.Unlock()
	close(fl.done)
	return fl.res, fl.err
}

// doRefresh is the fetch chain (port of doRefresh): acquire a concurrency slot →
// fetch the (rsshub-resolved) URL → persist every item AND stamp
// last_fetched_at in one transaction. The slot bounds concurrent fetch+persist
// bursts (see refreshConcurrency).
func (c *Cache) doRefresh(ctx context.Context, f model.Feed) (Result, error) {
	c.sem <- struct{}{}
	defer func() { <-c.sem }()

	target, err := store.ResolveURL(c.db.Reader(), f.URL)
	if err != nil {
		return Result{}, err
	}
	parsed, err := c.fetch(ctx, target)
	if err != nil {
		return Result{}, err
	}
	feedName := f.Name
	if parsed.Title != "" {
		feedName = parsed.Title
	}
	now := c.now()
	if err := store.RefreshPersist(c.db.Writer(), f.ID, feedName, f.URL, parsed.Items, now); err != nil {
		return Result{}, err
	}
	return Result{Items: parsed.Items, FeedName: feedName}, nil
}

// EnsureFresh is the port of ensureFresh: schedule an upstream fetch as needed
// before a feed's rows are served (callers read article_states afterward).
//   - fresh (fetched within TTL): no-op
//   - stale but previously fetched: refresh in the background, serve current rows
//   - never fetched, no rows yet (brand-new feed): await so first load has content
//   - never fetched but rows exist: treat as stale, refresh in the background
func (c *Cache) EnsureFresh(ctx context.Context, f model.Feed) error {
	var last int64
	if f.LastFetchedAt != nil {
		last = *f.LastFetchedAt
	}
	if last != 0 && c.now()-last < CacheTTL.Milliseconds() {
		return nil
	}
	if last != 0 {
		c.backgroundRefresh(f)
		return nil
	}
	hasRows, err := store.FeedHasRows(c.db.Reader(), f.ID)
	if err != nil {
		return err
	}
	if hasRows {
		c.backgroundRefresh(f)
		return nil
	}
	_, err = c.RefreshFeed(ctx, f)
	return err
}

// backgroundRefresh fires a refresh without blocking the caller; errors are
// swallowed (the Node path logs at debug and moves on).
func (c *Cache) backgroundRefresh(f model.Feed) {
	go func() {
		defer crash.Recover(slog.Default(), "background-refresh")
		_, _ = c.RefreshFeed(context.Background(), f)
	}()
}

// Ready reports whether startup cache warming has completed (gates readiness).
func (c *Cache) Ready() bool {
	c.readyMu.Lock()
	defer c.readyMu.Unlock()
	return c.ready
}

func (c *Cache) setReady() {
	c.readyMu.Lock()
	c.ready = true
	c.readyMu.Unlock()
}

// StartCacheWarming is the port of startCacheWarming: warm never-fetched feeds up
// front (gating Ready), refresh already-fetched-but-stale feeds in the
// background. It returns immediately; Ready() flips true once the uncached feeds
// settle. Callers gate it on TEST mode themselves (Node keys off TEST_DB).
func (c *Cache) StartCacheWarming() error {
	feeds, err := store.ListFeeds(c.db.Reader())
	if err != nil {
		return err
	}
	var uncached []model.Feed
	now := c.now()
	for _, f := range feeds {
		if f.LastFetchedAt != nil && now-*f.LastFetchedAt >= CacheTTL.Milliseconds() {
			c.backgroundRefresh(f) // stale: refresh in the background
		} else if f.LastFetchedAt == nil {
			uncached = append(uncached, f)
		}
	}
	if len(uncached) == 0 {
		c.setReady()
		return nil
	}
	go func() {
		defer crash.Recover(slog.Default(), "cache-warming")
		var wg sync.WaitGroup
		for _, f := range uncached {
			wg.Add(1)
			go func(f model.Feed) {
				defer crash.Recover(slog.Default(), "cache-warming-feed")
				defer wg.Done()
				_, _ = c.RefreshFeed(context.Background(), f)
			}(f)
		}
		wg.Wait()
		c.setReady()
	}()
	return nil
}
