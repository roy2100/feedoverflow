package ssrf

import (
	"context"
	"net"
)

// SetResolver swaps the DNS hook for tests (restored via the returned func),
// mirroring how ssrf.test.ts mocks dns.lookup.
func SetResolver(fn func(ctx context.Context, host string) ([]net.IP, error)) (restore func()) {
	prev := resolveHost
	resolveHost = fn
	return func() { resolveHost = prev }
}
