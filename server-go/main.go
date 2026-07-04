// Command server-go is the Go port of the RSS reader backend (see
// docs/plan-go-backend-migration.md). It opens the DB and serves the API on
// two listeners: a public, auth-gated one on PORT and a loopback-only,
// no-auth one on LOCAL_API_PORT — the latter also hosts the MCP server
// (POST /mcp, see internal/mcp).
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"strconv"

	"rss-reader/server-go/internal/cache"
	"rss-reader/server-go/internal/config"
	"rss-reader/server-go/internal/crash"
	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/favicon"
	"rss-reader/server-go/internal/httpapi"
	"rss-reader/server-go/internal/jobs"
	applog "rss-reader/server-go/internal/logger"
)

func main() {
	cfg := config.Load()

	// Shared structured logger built first so startup failures and panics land in
	// the NDJSON app.log, not just stderr: <LogDir>/app.log (rotated) when LogDir is
	// set, else stderr. slog stays the default so any stray stdlib slog use routes here.
	var appLogger *slog.Logger
	if cfg.LogDir != "" {
		appLogger = applog.New(applog.Config{Dir: cfg.LogDir})
	} else {
		appLogger = slog.New(slog.NewJSONHandler(os.Stderr, nil))
	}
	slog.SetDefault(appLogger)

	// Route a panic in the main goroutine through the structured logger before the
	// process exits (launchd KeepAlive restarts it) — the Go analogue of index.ts's
	// uncaughtException handler. Background goroutines carry their own crash.Guard;
	// a panic there cannot be caught here (Go panics don't cross goroutines).
	defer crash.Guard(appLogger, "main")

	// fatal logs a structured fatal record then exits(1), the analogue of Node's
	// logger.fatal(...) + process.exit(1) (replaces stdlib log.Fatalf → stderr-only).
	fatal := func(msg string, args ...any) {
		applog.Fatal(appLogger, msg, args...)
		os.Exit(1)
	}

	handle, err := db.OpenHandle(cfg.DBPath)
	if err != nil {
		fatal("open db failed", "err", err, "path", cfg.DBPath)
	}
	defer handle.Close()
	if err := db.InitSchema(handle.Writer()); err != nil {
		fatal("init schema failed", "err", err)
	}

	c := cache.New(handle, nil, cache.WithConcurrency(cfg.RefreshConcurrency)) // nil fetch → feed.ParseURL
	fav := favicon.New(handle, nil)                                            // nil fetch → Google s2
	srv := &httpapi.Server{
		DB: handle, Cache: c, Favicon: fav,
		AuthUser: cfg.AuthUser, AuthPass: cfg.AuthPass, DistDir: cfg.ClientDist,
		LocalAPIPort: cfg.LocalAPIPort,
	}

	localAddr := "127.0.0.1:" + strconv.Itoa(cfg.LocalAPIPort)
	go func() {
		defer crash.Guard(appLogger, "loopback-listener")
		appLogger.Info("loopback listening", "addr", localAddr)
		if err := http.ListenAndServe(localAddr, srv.NewLocalRouter()); err != nil {
			fatal("loopback listener failed", "err", err, "addr", localAddr)
		}
	}()

	// Background workers (poller, maintenance, WAL checkpoint, resource monitor,
	// cache warming). Gated by RSS_DISABLE_JOBS — the Go analogue of Node's TEST_DB
	// gate — so the contract-diff harness can keep the copy DB static.
	if !cfg.DisableJobs {
		if err := c.StartCacheWarming(); err != nil {
			appLogger.Warn("cache warming failed to start", "err", err)
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
	appLogger.Info("public listening", "addr", publicAddr, "db", cfg.DBPath, "auth", authState)
	if err := http.ListenAndServe(publicAddr, srv.NewPublicRouter()); err != nil {
		fatal("public listener failed", "err", err, "addr", publicAddr)
	}
}
