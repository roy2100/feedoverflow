// Package logger is the Go port of server/logger.ts + vendor/slog.ts: one shared
// structured logger writing NDJSON to logs/app.log with size rotation, gzip, and
// retention (via lumberjack). It exposes a *slog.Logger so call sites use the
// stdlib logging API; a custom slog.Handler reproduces the vendored record shape:
//
//	{ ts, t, level, lvl, msg, pid, host, ctx?, err? }
//
// where ts is ISO-8601 with ms, t is epoch-ms, level is the name and lvl its
// numeric severity (debug 20 / info 30 / warn 40 / error 50), and ctx holds the
// base fields (app) merged with the per-call structured fields. An attr named
// "err" carrying an error is lifted into the top-level err object. The vendored
// schema-header line is intentionally omitted; the per-record shape is unchanged.
package logger

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"sync"
	"time"

	lumberjack "gopkg.in/natefinch/lumberjack.v2"
)

// Config controls the logger. Zero values fall back to the vendored defaults.
type Config struct {
	Dir        string     // log directory (default "logs")
	Filename   string     // base name without extension (default "app")
	Level      slog.Level // minimum level (default Info)
	MaxSizeMB  int        // rotate when the active file exceeds this (default 10)
	MaxBackups int        // rotated files to keep (default 5)
	MaxAgeDays int        // delete rotated files older than this (default 14)
	Compress   bool       // gzip rotated files (default true; set via New)
	App        string     // base ctx.app value (default "rss-reader")
	Writer     io.Writer  // override sink (tests); when set, rotation config is ignored
}

// New builds the shared logger. Unless Writer is set, output goes to a
// lumberjack-rotated <Dir>/<Filename>.log.
func New(cfg Config) *slog.Logger {
	if cfg.Filename == "" {
		cfg.Filename = "app"
	}
	if cfg.Dir == "" {
		cfg.Dir = "logs"
	}
	if cfg.MaxSizeMB == 0 {
		cfg.MaxSizeMB = 10
	}
	if cfg.MaxBackups == 0 {
		cfg.MaxBackups = 5
	}
	if cfg.MaxAgeDays == 0 {
		cfg.MaxAgeDays = 14
	}
	if cfg.App == "" {
		cfg.App = "rss-reader"
	}

	w := cfg.Writer
	if w == nil {
		w = &lumberjack.Logger{
			Filename:   cfg.Dir + "/" + cfg.Filename + ".log",
			MaxSize:    cfg.MaxSizeMB,
			MaxBackups: cfg.MaxBackups,
			MaxAge:     cfg.MaxAgeDays,
			Compress:   true,
		}
	}
	host, _ := os.Hostname()
	h := &handler{
		w:     w,
		level: cfg.Level,
		pid:   os.Getpid(),
		host:  host,
		app:   cfg.App,
		mu:    &sync.Mutex{},
	}
	return slog.New(h)
}

// levelName / levelNum map slog levels to the vendored name + numeric severity.
func levelName(l slog.Level) (string, int) {
	switch {
	case l <= slog.LevelDebug:
		return "debug", 20
	case l < slog.LevelWarn:
		return "info", 30
	case l < slog.LevelError:
		return "warn", 40
	default:
		return "error", 50
	}
}

type handler struct {
	w     io.Writer
	level slog.Level
	pid   int
	host  string
	app   string
	attrs []slog.Attr // accumulated via WithAttrs
	group string      // single-level group prefix (WithGroup); rarely used here
	mu    *sync.Mutex
}

func (h *handler) Enabled(_ context.Context, l slog.Level) bool { return l >= h.level }

func (h *handler) WithAttrs(as []slog.Attr) slog.Handler {
	nh := *h
	nh.attrs = append(append([]slog.Attr{}, h.attrs...), as...)
	return &nh
}

func (h *handler) WithGroup(name string) slog.Handler {
	nh := *h
	nh.group = name
	return &nh
}

func (h *handler) Handle(_ context.Context, r slog.Record) error {
	name, num := levelName(r.Level)
	ts := r.Time
	if ts.IsZero() {
		ts = time.Now()
	}

	ctx := map[string]any{"app": h.app}
	var errObj map[string]any

	add := func(a slog.Attr) {
		if a.Key == "err" {
			if e, ok := a.Value.Any().(error); ok {
				errObj = serializeError(e)
				return
			}
		}
		ctx[a.Key] = a.Value.Any()
	}
	for _, a := range h.attrs {
		add(a)
	}
	r.Attrs(func(a slog.Attr) bool {
		add(a)
		return true
	})

	rec := map[string]any{
		"ts":    ts.UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		"t":     ts.UnixMilli(),
		"level": name,
		"lvl":   num,
		"msg":   r.Message,
		"pid":   h.pid,
		"host":  h.host,
		"ctx":   ctx,
	}
	if errObj != nil {
		rec["err"] = errObj
	}

	line, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	line = append(line, '\n')
	h.mu.Lock()
	defer h.mu.Unlock()
	_, err = h.w.Write(line)
	return err
}

// serializeError mirrors vendor/slog.ts serializeError: name + message (+ cause
// chain, capped). Go errors carry no name, so "error" is used.
func serializeError(e error) map[string]any {
	out := map[string]any{"name": "error", "message": e.Error()}
	if u := unwrap(e); u != nil {
		out["cause"] = u.Error()
	}
	return out
}

func unwrap(e error) error {
	type unwrapper interface{ Unwrap() error }
	if u, ok := e.(unwrapper); ok {
		return u.Unwrap()
	}
	return nil
}
