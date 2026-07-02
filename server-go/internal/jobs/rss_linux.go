//go:build linux

package jobs

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// processRSSBytes returns the current resident set size of this process by
// reading field 2 (resident pages) of /proc/self/statm — the linux analogue of
// Node's process.memoryUsage().rss. Includes cgo/SQLite pages that
// runtime.MemStats.Sys omits. ok=false on failure so the caller can fall back.
func processRSSBytes() (uint64, bool) {
	data, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0, false
	}
	fields := strings.Fields(string(data))
	if len(fields) < 2 {
		return 0, false
	}
	pages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0, false
	}
	return pages * uint64(syscall.Getpagesize()), true
}
