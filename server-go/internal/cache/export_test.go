package cache

// Test-only accessors (compiled only under `go test`) so external tests can pin
// the clock, swap the fetch func mid-run, and observe single-flight state without
// widening the public API.

func SetClock(c *Cache, now func() int64) { c.now = now }

func SetFetch(c *Cache, f FetchFunc) { c.fetch = f }

func (c *Cache) InflightLen() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.inflight)
}
