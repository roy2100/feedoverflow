// Command server-go is the Go port of the RSS reader backend (see
// docs/plan-go-backend-migration.md). Through Phase 4 it opens the DB and serves
// the read API on two listeners: a public, auth-gated one on PORT and a
// loopback-only, no-auth one on LOCAL_API_PORT.
package main

import (
	"log"
	"net/http"
	"strconv"

	"rss-reader/server-go/internal/config"
	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/httpapi"
)

func main() {
	cfg := config.Load()

	handle, err := db.OpenHandle(cfg.DBPath)
	if err != nil {
		log.Fatalf("open db %s: %v", cfg.DBPath, err)
	}
	defer handle.Close()
	if err := db.InitSchema(handle.Writer()); err != nil {
		log.Fatalf("init schema: %v", err)
	}

	srv := &httpapi.Server{DB: handle, AuthUser: cfg.AuthUser, AuthPass: cfg.AuthPass}

	localAddr := "127.0.0.1:" + strconv.Itoa(cfg.LocalAPIPort)
	go func() {
		log.Printf("server-go loopback listening on %s", localAddr)
		if err := http.ListenAndServe(localAddr, srv.NewLocalRouter()); err != nil {
			log.Fatalf("loopback listener failed: %v", err)
		}
	}()

	publicAddr := ":" + strconv.Itoa(cfg.Port)
	authState := "disabled"
	if cfg.AuthUser != "" && cfg.AuthPass != "" {
		authState = "enabled"
	}
	log.Printf("server-go public listening on %s (db=%s, auth=%s)", publicAddr, cfg.DBPath, authState)
	if err := http.ListenAndServe(publicAddr, srv.NewPublicRouter()); err != nil {
		log.Fatalf("public listener failed: %v", err)
	}
}
