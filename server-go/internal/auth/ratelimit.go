package auth

import (
	"sync"
	"time"
)

// rateLimiter is a fixed-window per-key counter, matching express-rate-limit's
// model (max requests per window, keyed by client IP). Over the limit within the
// window → denied until the window rolls.
type rateLimiter struct {
	window time.Duration
	max    int
	mu     sync.Mutex
	hits   map[string]*window
}

type window struct {
	count int
	start time.Time
}

func newRateLimiter(win time.Duration, max int) *rateLimiter {
	return &rateLimiter{window: win, max: max, hits: map[string]*window{}}
}

// allow records a hit for key and reports whether it is within the limit.
func (rl *rateLimiter) allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	w := rl.hits[key]
	if w == nil || now.Sub(w.start) >= rl.window {
		rl.hits[key] = &window{count: 1, start: now}
		return true
	}
	w.count++
	return w.count <= rl.max
}
