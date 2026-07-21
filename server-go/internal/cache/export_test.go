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

// InflightJoined reports how many callers have coalesced onto feedID's in-flight
// refresh, the leader excluded. A test can spin on this to know coalescing has
// actually happened, rather than assuming it from the mere existence of a flight.
func (c *Cache) InflightJoined(feedID string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if fl, ok := c.inflight[feedID]; ok {
		return fl.joined
	}
	return 0
}
