// Command server-go is the Go port of the RSS reader backend (see
// docs/plan-go-backend-migration.md). Through Phase 3 it opens the DB and serves
// the pure-read /api/* endpoints on a single loopback listener for contract-diff.
package main

import (
	"log"
	"net/http"
	"os"

	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/httpapi"
)

func main() {
	dbPath := os.Getenv("RSS_DB")
	if dbPath == "" {
		dbPath = "rss.db"
	}
	sqldb, err := db.Open(dbPath)
	if err != nil {
		log.Fatalf("open db %s: %v", dbPath, err)
	}
	defer sqldb.Close()
	if err := db.InitSchema(sqldb); err != nil {
		log.Fatalf("init schema: %v", err)
	}

	addr := os.Getenv("GO_ADDR")
	if addr == "" {
		addr = "127.0.0.1:3012"
	}
	srv := &http.Server{
		Addr:    addr,
		Handler: (&httpapi.Server{DB: sqldb}).NewRouter(),
	}

	log.Printf("server-go listening on %s (db=%s)", addr, dbPath)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server-go failed: %v", err)
	}
}
