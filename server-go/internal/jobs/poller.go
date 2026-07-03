package jobs

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"rss-reader/server-go/internal/cache"
	"rss-reader/server-go/internal/crash"
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
	// Eager first runs, guarded so a panic on the very first pass is logged and
	// swallowed rather than crashing startup.
	r.safeRun("maintenance", func() { RunMaintenance(r.DB, r.CapBytes, r.Log) })
	r.safeRun("checkpoint", func() { CheckpointWAL(r.DB.Writer(), r.Log) })

	go r.tick(ctx, "maintenance", maintenanceInterval, func() { RunMaintenance(r.DB, r.CapBytes, r.Log) })
	go r.tick(ctx, "checkpoint", checkpointInterval, func() { CheckpointWAL(r.DB.Writer(), r.Log) })

	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(pollStartDelay):
		}
		r.safeRun("poller", func() { r.pollAllFeeds(ctx) })
		r.tick(ctx, "poller", pollInterval, func() { r.pollAllFeeds(ctx) })
	}()
}

// safeRun runs fn under crash.Recover: a panic in one unit of work is logged at
// error level (with stack) and swallowed so the caller's loop keeps running — the
// Go-idiomatic per-iteration recovery (cf. net/http per-request), instead of
// taking down the process. crash.Guard/os.Exit is reserved for main + listeners.
func (r *Runner) safeRun(name string, fn func()) {
	defer crash.Recover(r.Log, name)
	fn()
}

// tick runs fn every d until ctx is cancelled, each run guarded by safeRun so one
// panicking iteration does not kill the worker. (fn is not run immediately —
// callers that need an eager first run invoke it via safeRun before tick.)
func (r *Runner) tick(ctx context.Context, name string, d time.Duration, fn func()) {
	t := time.NewTicker(d)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.safeRun(name, fn)
		}
	}
}

// pollAllFeeds refreshes every feed concurrently and waits for the batch to
// finish. There is no artificial per-feed stagger: the cache's REFRESH_CONCURRENCY
// slot cap (internal/cache, REFRESH_CONCURRENCY) is the single throttle on how many
// fetch+persist chains run at once, so the poll fans out and lets that cap bound
// it. Each feed runs under safeRun so one panicking fetch doesn't take the batch
// down. Port of pollAllFeeds.
func (r *Runner) pollAllFeeds(ctx context.Context) {
	feeds, err := store.ListFeeds(r.DB.Reader())
	if err != nil {
		r.Log.Warn("poll: list feeds failed", "err", err)
		return
	}
	var wg sync.WaitGroup
	for _, f := range feeds {
		if ctx.Err() != nil {
			break
		}
		f := f
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.safeRun("feed-poll "+f.ID, func() {
				if _, err := r.Cache.RefreshFeed(ctx, f); err != nil {
					r.Log.Warn("feed poll failed", "feedId", f.ID, "feedUrl", f.URL, "err", err)
				}
			})
		}()
	}
	wg.Wait()
}
