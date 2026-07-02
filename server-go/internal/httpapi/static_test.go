package httpapi

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeDist writes a minimal client build (index.html + an asset) into a temp dir.
func makeDist(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html><title>SPA</title>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "assets", "app.js"), []byte("console.log('app')"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestSPAServesIndexAndAssets(t *testing.T) {
	s := &Server{DB: testDB(t), DistDir: makeDist(t)}
	h := s.NewPublicRouter() // auth disabled (no creds)

	// GET / → index.html.
	if rec := do(h, "GET", "/", "", nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), "<title>SPA</title>") {
		t.Fatalf("GET /: %d %q", rec.Code, rec.Body.String())
	}
	// Existing asset served directly.
	rec := do(h, "GET", "/assets/app.js", "", nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "console.log") {
		t.Fatalf("GET /assets/app.js: %d %q", rec.Code, rec.Body.String())
	}
	// Unknown non-/api path → SPA fallback (index.html).
	rec = do(h, "GET", "/some/client/route", "", nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "<title>SPA</title>") {
		t.Fatalf("SPA fallback: %d %q", rec.Code, rec.Body.String())
	}
}

func TestSPANeverShadowsAPI(t *testing.T) {
	s := &Server{DB: testDB(t), DistDir: makeDist(t)}
	h := s.NewPublicRouter()

	// Unknown /api path must NOT get the SPA HTML — it 404s.
	rec := do(h, "GET", "/api/does-not-exist", "", nil)
	if rec.Code != 404 {
		t.Fatalf("unknown /api: want 404, got %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "<title>SPA</title>") {
		t.Error("SPA HTML leaked onto an /api path")
	}
	// A real API route still works (not swallowed by the fallback).
	if rec := do(h, "GET", "/api/feeds", "", nil); rec.Code != 200 {
		t.Fatalf("GET /api/feeds: %d", rec.Code)
	}
}

func TestLocalRouterNoSPA(t *testing.T) {
	s := &Server{DB: testDB(t), DistDir: makeDist(t)}
	h := s.NewLocalRouter() // loopback listener: no static/SPA

	if rec := do(h, "GET", "/", "", nil); rec.Code != 404 {
		t.Fatalf("loopback GET /: want 404 (no SPA), got %d", rec.Code)
	}
}
