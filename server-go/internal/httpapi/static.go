package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// spaFallback serves the client build: an existing static asset under DistDir is
// served directly; any other non-/api path falls back to index.html (the SPA
// router then handles it client-side). Ports express.static(distDir) + the
// app.get('*') fallback. Unmatched /api paths are NOT served the SPA — they 404,
// so the fallback can never shadow or masquerade as an API route.
func (s *Server) spaFallback(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api") {
		http.NotFound(w, r)
		return
	}

	// Resolve the request path safely under DistDir (filepath.Clean + the DistDir
	// prefix check block ../ traversal).
	clean := filepath.Clean("/" + r.URL.Path) // leading slash makes Clean strip any ../
	full := filepath.Join(s.DistDir, clean)
	if rel, err := filepath.Rel(s.DistDir, full); err != nil || strings.HasPrefix(rel, "..") {
		http.NotFound(w, r)
		return
	}
	if info, err := os.Stat(full); err == nil && !info.IsDir() {
		http.ServeFile(w, r, full)
		return
	}
	// SPA fallback.
	http.ServeFile(w, r, filepath.Join(s.DistDir, "index.html"))
}
