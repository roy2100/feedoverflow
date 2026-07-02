//go:build !darwin && !linux

package jobs

// processRSSBytes has no portable implementation on this platform; the caller
// falls back to runtime.MemStats.Sys.
func processRSSBytes() (uint64, bool) { return 0, false }
