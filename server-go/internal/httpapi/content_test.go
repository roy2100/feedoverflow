package httpapi

import (
	"context"
	"strings"
	"testing"

	"rss-reader/server-go/internal/favicon"
)

func TestFetchContentValidation(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()

	// Missing url → 400.
	if rec := do(h, "GET", "/api/fetch-content", "", nil); rec.Code != 400 ||
		!strings.Contains(rec.Body.String(), "url required") {
		t.Fatalf("no-url: %d %s", rec.Code, rec.Body.String())
	}

	// SSRF-blocked target → 400 Blocked URL (no network hit).
	rec := do(h, "GET", "/api/fetch-content?url=http://127.0.0.1/secret", "", nil)
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "Blocked URL") {
		t.Fatalf("blocked url: %d %s", rec.Code, rec.Body.String())
	}

	// Non-http scheme → 400 Blocked URL (SSRF guard rejects protocol).
	rec = do(h, "GET", "/api/fetch-content?url=file:///etc/passwd", "", nil)
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "Blocked URL") {
		t.Fatalf("file url: %d %s", rec.Code, rec.Body.String())
	}
}

func TestFaviconRouteServesBlob(t *testing.T) {
	handle := testDB(t)
	s := &Server{
		DB: handle,
		Favicon: favicon.New(handle, func(context.Context, string) ([]byte, string, error) {
			return []byte("ICONBYTES"), "image/png", nil
		}),
	}
	h := s.NewLocalRouter()

	rec := do(h, "GET", "/api/favicon?domain=example.com", "", nil)
	if rec.Code != 200 {
		t.Fatalf("favicon: %d", rec.Code)
	}
	if rec.Body.String() != "ICONBYTES" {
		t.Errorf("favicon body: %q", rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("favicon content-type: %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "604800") {
		t.Errorf("favicon cache-control: %q", cc)
	}
}

func TestFaviconRouteServesPlaceholder(t *testing.T) {
	handle := testDB(t)
	// Fetch always fails → nil result → placeholder SVG.
	s := &Server{
		DB: handle,
		Favicon: favicon.New(handle, func(context.Context, string) ([]byte, string, error) {
			return nil, "", context.Canceled
		}),
	}
	h := s.NewLocalRouter()

	// Invalid domain also yields the placeholder.
	rec := do(h, "GET", "/api/favicon?domain=not+a+domain", "", nil)
	if rec.Code != 200 {
		t.Fatalf("placeholder: %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != favicon.DefaultContentType {
		t.Errorf("placeholder content-type: %q", ct)
	}
	if !strings.Contains(rec.Body.String(), "<svg") {
		t.Errorf("placeholder not SVG: %q", rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "86400") {
		t.Errorf("placeholder cache-control: %q", cc)
	}
}
