// Command server-go is the Go port of the RSS reader backend (see
// docs/plan-go-backend-migration.md). Phase 0 is a scaffold: it serves only
// /healthz so the cgo build + chi wiring can be verified end to end.
package main

import (
	"log"
	"net/http"
	"os"

	"rss-reader/server-go/internal/httpapi"
)

func main() {
	addr := os.Getenv("GO_ADDR")
	if addr == "" {
		addr = "127.0.0.1:3012"
	}

	srv := &http.Server{
		Addr:    addr,
		Handler: httpapi.NewRouter(),
	}

	log.Printf("server-go listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server-go failed: %v", err)
	}
}
