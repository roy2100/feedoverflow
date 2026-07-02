package jobs

import (
	"context"
	"log/slog"
	"math/rand"
	"time"

	"rss-reader/server-go/internal/cache"
	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/store"
)

const (
	pollInterval        = 15 * time.Minute
	maintenanceInterval = 24 * time.Hour
	// checkpointInterval reclaims the WAL far more often than the poll/maintenance
	// passes so it stays small between write bursts.
	checkpointInterval = 5 * time.Minute
	// pollStartDelay defers the first poll so startup warming/serving settles first.
	pollStartDelay = 5 * time.Second
	sampleInterval = 5 * time.Minute
)

// Runner owns the background workers and their dependencies.
type Runner struct {
	DB       *db.DB
	Cache    *cache.Cache
	Log      *slog.Logger
	CapBytes int64
	DBPath   string
}

// Start launches every background worker (poller + maintenance + checkpoint +
// resource monitor). Each stops when ctx is cancelled. Startup cache warming is
// kicked separately by the caller (cache.StartCacheWarming), matching index.ts.
func (r *Runner) Start(ctx context.Context) {
	r.StartPoller(ctx)
	r.StartResourceMonitor(ctx)
}

// StartPoller ports startPoller: run maintenance now + every 24h, checkpoint the
// WAL now + every 5 min, and (after a 5s delay) poll all feeds every 15 min.
func (r *Runner) StartPoller(ctx context.Context) {
	RunMaintenance(r.DB, r.CapBytes, r.Log)
	CheckpointWAL(r.DB.Writer(), r.Log)

	go r.tick(ctx, maintenanceInterval, func() { RunMaintenance(r.DB, r.CapBytes, r.Log) })
	go r.tick(ctx, checkpointInterval, func() { CheckpointWAL(r.DB.Writer(), r.Log) })

	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(pollStartDelay):
		}
		r.pollAllFeeds(ctx)
		r.tick(ctx, pollInterval, func() { r.pollAllFeeds(ctx) })
	}()
}

// tick runs fn every d until ctx is cancelled (fn is not run immediately — callers
// that need an eager first run invoke it before tick, like Node's leading call).
func (r *Runner) tick(ctx context.Context, d time.Duration, fn func()) {
	t := time.NewTicker(d)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			fn()
		}
	}
}

// pollAllFeeds refreshes every feed, staggered 2–5s apart so the fan-out doesn't
// bunch (the single-flight + concurrency cap in cache also bound it). Port of
// pollAllFeeds.
func (r *Runner) pollAllFeeds(ctx context.Context) {
	feeds, err := store.ListFeeds(r.DB.Reader())
	if err != nil {
		r.Log.Warn("poll: list feeds failed", "err", err)
		return
	}
	for i, f := range feeds {
		if i > 0 {
			delay := time.Duration(2000+rand.Intn(3000)) * time.Millisecond
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
		}
		if _, err := r.Cache.RefreshFeed(ctx, f); err != nil {
			r.Log.Warn("feed poll failed", "feedId", f.ID, "feedUrl", f.URL, "err", err)
		}
	}
}
