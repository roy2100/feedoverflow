package favicon

// SetClock pins the cache's clock for deterministic TTL tests.
func SetClock(c *Cache, now func() int64) { c.now = now }
