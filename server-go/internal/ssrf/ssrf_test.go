package ssrf_test

import (
	"context"
	"net"
	"strings"
	"testing"

	"rss-reader/server-go/internal/ssrf"
)

func assertErr(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error containing %q, got nil", want)
	}
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("error %q does not contain %q", err.Error(), want)
	}
}

func assertOK(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func ctx() context.Context { return context.Background() }

func TestRejectsMalformedURLs(t *testing.T) {
	assertErr(t, ssrf.AssertSafeURL(ctx(), "not a url"), "Invalid URL")
	assertErr(t, ssrf.AssertSafeURL(ctx(), ""), "Invalid URL")
}

func TestRejectsNonHTTPProtocols(t *testing.T) {
	assertErr(t, ssrf.AssertSafeURL(ctx(), "ftp://example.com/x"), "Only http/https")
	assertErr(t, ssrf.AssertSafeURL(ctx(), "file:///etc/passwd"), "Only http/https")
	assertErr(t, ssrf.AssertSafeURL(ctx(), "gopher://example.com"), "Only http/https")
}

func TestBlocksLiteralPrivateIPv4(t *testing.T) {
	for _, ip := range []string{
		"127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.5",
		"169.254.169.254", // cloud metadata
		"100.64.0.1",      // CGNAT
		"0.0.0.0",
	} {
		assertErr(t, ssrf.AssertSafeURL(ctx(), "http://"+ip+"/"), "Blocked address")
	}
}

func TestBlocksLiteralPrivateIPv6(t *testing.T) {
	for _, host := range []string{
		"[::1]", "[::]", "[fc00::1]", "[fe80::1]",
		"[::ffff:127.0.0.1]",       // → loopback
		"[::ffff:10.0.0.1]",        // → private
		"[::ffff:169.254.169.254]", // → cloud metadata
	} {
		assertErr(t, ssrf.AssertSafeURL(ctx(), "http://"+host+"/"), "Blocked address")
	}
}

func TestBlocksMappedIPv4FromDNS(t *testing.T) {
	for _, addr := range []string{"::ffff:127.0.0.1", "::ffff:10.0.0.1"} {
		restore := ssrf.SetResolver(func(context.Context, string) ([]net.IP, error) {
			return []net.IP{net.ParseIP(addr)}, nil
		})
		assertErr(t, ssrf.AssertSafeURL(ctx(), "http://mapped.example.com/"), "Blocked address")
		restore()
	}
}

func TestAllowsPublicMappedIPv6(t *testing.T) {
	assertOK(t, ssrf.AssertSafeURL(ctx(), "http://[::ffff:8.8.8.8]/"))
}

func TestAllowsLiteralPublicIPsWithoutDNS(t *testing.T) {
	called := false
	restore := ssrf.SetResolver(func(context.Context, string) ([]net.IP, error) {
		called = true
		return nil, nil
	})
	defer restore()
	assertOK(t, ssrf.AssertSafeURL(ctx(), "http://8.8.8.8/"))
	assertOK(t, ssrf.AssertSafeURL(ctx(), "https://1.1.1.1/path"))
	assertOK(t, ssrf.AssertSafeURL(ctx(), "http://[2606:4700:4700::1111]/")) // public IPv6
	if called {
		t.Fatal("literal IPs must skip DNS resolution")
	}
}

func TestAllowsPublicResolvingHost(t *testing.T) {
	restore := ssrf.SetResolver(func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("93.184.216.34")}, nil
	})
	defer restore()
	assertOK(t, ssrf.AssertSafeURL(ctx(), "https://example.com/page"))
}

func TestBlocksHostResolvingToPrivate(t *testing.T) {
	restore := ssrf.SetResolver(func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("10.0.0.5")}, nil
	})
	defer restore()
	assertErr(t, ssrf.AssertSafeURL(ctx(), "http://evil.example.com/"), "Blocked address")
}

func TestBlocksWhenAnyResolvedIsPrivate(t *testing.T) {
	restore := ssrf.SetResolver(func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("93.184.216.34"), net.ParseIP("192.168.1.1")}, nil
	})
	defer restore()
	assertErr(t, ssrf.AssertSafeURL(ctx(), "http://mixed.example.com/"), "Blocked address")
}

func TestRejectsNonResolvingHost(t *testing.T) {
	restore := ssrf.SetResolver(func(context.Context, string) ([]net.IP, error) {
		return []net.IP{}, nil
	})
	defer restore()
	assertErr(t, ssrf.AssertSafeURL(ctx(), "http://nxdomain.invalid/"), "did not resolve")
}
