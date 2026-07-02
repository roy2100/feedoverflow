package jobs

import (
	"context"
	"os"
	"runtime"
	"syscall"
	"time"
)

const mb = 1024 * 1024

func toMB(bytes uint64) float64 {
	return float64(int64(float64(bytes)/mb*10+0.5)) / 10 // 0.1 MB rounding
}

// dbSizeMB is the main SQLite file size on disk (excludes -wal/-shm), or nil on
// stat failure — the same logical size the cap is enforced against, lagging only
// by not-yet-checkpointed WAL frames. Port of ln.ts dbSizeMb.
func (r *Runner) dbSizeMB() *float64 {
	fi, err := os.Stat(r.DBPath)
	if err != nil {
		return nil
	}
	v := toMB(uint64(fi.Size()))
	return &v
}

// cpuMicros returns cumulative user+system CPU time in microseconds (getrusage),
// the Go analogue of process.cpuUsage().
func cpuMicros() int64 {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return 0
	}
	u := int64(ru.Utime.Sec)*1e6 + int64(ru.Utime.Usec)
	s := int64(ru.Stime.Sec)*1e6 + int64(ru.Stime.Usec)
	return u + s
}

// StartResourceMonitor ports ln.ts: log one structured resource sample on boot
// (cpuPercent nil — no prior window) then every 5 min, rating CPU against the
// elapsed wall time. Runs until ctx is cancelled.
func (r *Runner) StartResourceMonitor(ctx context.Context) {
	start := time.Now()
	prevCPU := cpuMicros()
	prevWall := time.Now()

	r.logSample(nil, start)

	go func() {
		t := time.NewTicker(sampleInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				cpu := cpuMicros()
				now := time.Now()
				wallMicros := float64(now.Sub(prevWall).Microseconds())
				var pct float64
				if wallMicros > 0 {
					pct = float64(int64(float64(cpu-prevCPU)/wallMicros*1000+0.5)) / 10
				}
				prevCPU = cpu
				prevWall = now
				r.logSample(&pct, start)
			}
		}
	}()
}

func (r *Runner) logSample(cpuPercent *float64, start time.Time) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	// True process RSS (parity with Node's process.memoryUsage().rss) — includes
	// cgo/SQLite malloc + mmap that runtime.MemStats.Sys omits. Fall back to Sys
	// if the platform probe fails.
	rss := m.Sys
	if b, ok := processRSSBytes(); ok {
		rss = b
	}
	attrs := []any{
		"rssMb", toMB(rss),
		"heapUsedMb", toMB(m.HeapAlloc),
		"heapTotalMb", toMB(m.HeapSys),
		"dbMb", derefFloat(r.dbSizeMB()), // nil (JSON null) on stat failure, like ln.ts
		"uptimeSec", int64(time.Since(start).Seconds()),
		"cpuPercent", derefFloat(cpuPercent), // nil on the boot sample
	}
	r.Log.Info("resource sample", attrs...)
}

// derefFloat returns the value a *float64 points at, or nil so slog logs a JSON
// null rather than the pointer address.
func derefFloat(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}
