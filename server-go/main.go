// Command server-go is the Go port of the RSS reader backend (see
// docs/plan-go-backend-migration.md). Through Phase 4 it opens the DB and serves
// the read API on two listeners: a public, auth-gated one on PORT and a
// loopback-only, no-auth one on LOCAL_API_PORT.
package main

import (
	"context"
	"log"
	"log/slog"
	"net/http"
	"os"
	"strconv"

	"rss-reader/server-go/internal/cache"
	"rss-reader/server-go/internal/config"
	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/favicon"
	"rss-reader/server-go/internal/httpapi"
	"rss-reader/server-go/internal/jobs"
	applog "rss-reader/server-go/internal/logger"
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

	// Shared structured logger: NDJSON to <LogDir>/app.log (rotated) when LogDir is
	// set, else stderr. slog stays the default so any stray stdlib slog use routes here.
	var appLogger *slog.Logger
	if cfg.LogDir != "" {
		appLogger = applog.New(applog.Config{Dir: cfg.LogDir})
	} else {
		appLogger = slog.New(slog.NewJSONHandler(os.Stderr, nil))
	}
	slog.SetDefault(appLogger)

	c := cache.New(handle, nil)     // nil fetch → feed.ParseURL
	fav := favicon.New(handle, nil) // nil fetch → Google s2
	srv := &httpapi.Server{
		DB: handle, Cache: c, Favicon: fav,
		AuthUser: cfg.AuthUser, AuthPass: cfg.AuthPass, DistDir: cfg.ClientDist,
	}

	localAddr := "127.0.0.1:" + strconv.Itoa(cfg.LocalAPIPort)
	go func() {
		log.Printf("server-go loopback listening on %s", localAddr)
		if err := http.ListenAndServe(localAddr, srv.NewLocalRouter()); err != nil {
			log.Fatalf("loopback listener failed: %v", err)
		}
	}()

	// Background workers (poller, maintenance, WAL checkpoint, resource monitor,
	// cache warming). Gated by RSS_DISABLE_JOBS — the Go analogue of Node's TEST_DB
	// gate — so the contract-diff harness can keep the copy DB static.
	if !cfg.DisableJobs {
		if err := c.StartCacheWarming(); err != nil {
			log.Printf("cache warming failed to start: %v", err)
		}
		runner := &jobs.Runner{
			DB: handle, Cache: c, Log: appLogger,
			CapBytes: cfg.DBMaxSizeBytes, DBPath: cfg.DBPath,
		}
		runner.Start(context.Background())
	}

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
