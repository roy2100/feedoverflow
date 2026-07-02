// Package ssrf is the Go port of server/ssrf.ts: an SSRF guard for server-side
// fetches of client-supplied URLs (/api/fetch-content). It resolves the host and
// refuses any URL that points at a private / loopback / link-local / metadata
// address, so a visitor can't make the server probe the internal network.
//
// Known limitation (same as the Node version): the HTTP client re-resolves DNS
// independently, so a determined attacker could rebind between this check and the
// fetch. Acceptable for a low-value home demo; pin the resolved IP if this ever
// guards something sensitive.
package ssrf

import (
	"context"
	"errors"
	"net"
	"net/url"
)

// privateV4CIDRs mirrors isPrivateIPv4 in ssrf.ts exactly (a superset of Go's
// net.IP.IsPrivate: it also covers 0.0.0.0/8, 100.64.0.0/10 CGNAT, all of
// 127/8 loopback, and 169.254/16 link-local incl. the cloud metadata endpoint).
var privateV4CIDRs = mustCIDRs(
	"0.0.0.0/8",      // "this" network
	"10.0.0.0/8",     // private
	"100.64.0.0/10",  // CGNAT
	"127.0.0.0/8",    // loopback
	"169.254.0.0/16", // link-local (incl. 169.254.169.254 metadata)
	"172.16.0.0/12",  // private
	"192.168.0.0/16", // private
)

func mustCIDRs(cidrs ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			panic(err)
		}
		out = append(out, n)
	}
	return out
}

func isPrivateIPv4(ip net.IP) bool {
	for _, n := range privateV4CIDRs {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// isPrivateIP classifies any parsed IP. Go's net.ParseIP normalizes an
// IPv4-mapped IPv6 address (::ffff:a.b.c.d, in dotted or hex-compressed form) so
// that To4() yields the embedded IPv4 — covering the mapped cases ssrf.ts handles
// via mappedIPv4. Pure IPv6 is classified against the same ranges Node checks.
func isPrivateIP(ip net.IP) bool {
	if v4 := ip.To4(); v4 != nil {
		return isPrivateIPv4(v4)
	}
	// Pure IPv6: ::1 loopback, :: unspecified, fc00::/7 unique-local, fe80::/10
	// link-local. Go's helpers cover exactly these, matching isPrivateIP in ssrf.ts.
	return ip.IsLoopback() || ip.IsUnspecified() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

// resolveHost is the DNS hook (overridable in tests via SetResolver). It returns
// every address the host resolves to, like dns.lookup(host, { all: true }).
var resolveHost = func(ctx context.Context, host string) ([]net.IP, error) {
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	ips := make([]net.IP, len(addrs))
	for i, a := range addrs {
		ips[i] = a.IP
	}
	return ips, nil
}

// AssertSafeURL returns an error if raw is not an http(s) URL or resolves to a
// non-public address — the port of assertSafeUrl. Error messages match ssrf.ts so
// the /api/fetch-content 400 detail is identical.
func AssertSafeURL(ctx context.Context, raw string) error {
	u, err := url.Parse(raw)
	// new URL(raw) throws on a schemeless / malformed input → "Invalid URL".
	if err != nil || u.Scheme == "" {
		return errors.New("Invalid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("Only http/https URLs are allowed")
	}
	host := u.Hostname() // strips IPv6 brackets
	if host == "" {
		return errors.New("Invalid URL")
	}
	// Literal IP: classify directly, no DNS (matching the net.isIP branch).
	if ip := net.ParseIP(host); ip != nil {
		if isPrivateIP(ip) {
			return errors.New("Blocked address")
		}
		return nil
	}
	addrs, err := resolveHost(ctx, host)
	if err != nil {
		return errors.New("Host did not resolve")
	}
	if len(addrs) == 0 {
		return errors.New("Host did not resolve")
	}
	for _, ip := range addrs {
		if isPrivateIP(ip) {
			return errors.New("Blocked address")
		}
	}
	return nil
}
