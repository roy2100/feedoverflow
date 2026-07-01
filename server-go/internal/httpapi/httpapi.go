// Package httpapi assembles the HTTP layer: the chi router, middleware, and the
// /api/* route handlers. Counterpart to server/app.ts + server/routes/*.
//
// Phase 0: only a /healthz liveness endpoint so the scaffold is verifiable.
package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// NewRouter builds the base router. Real /api/* routes are added in later phases.
func NewRouter() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	return r
}
