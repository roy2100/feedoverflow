package logger_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"strings"
	"testing"

	"rss-reader/server-go/internal/logger"
)

func TestNDJSONShape(t *testing.T) {
	var buf bytes.Buffer
	log := logger.New(logger.Config{Writer: &buf, Level: slog.LevelInfo})

	log.Info("feed poll failed", "feedId", "f1", "count", 3, "err", errors.New("boom"))

	line := strings.TrimSpace(buf.String())
	var rec map[string]any
	if err := json.Unmarshal([]byte(line), &rec); err != nil {
		t.Fatalf("not valid JSON: %v (%q)", err, line)
	}

	// Required top-level fields (the vendored NDJSON shape).
	for _, k := range []string{"ts", "t", "level", "lvl", "msg", "pid", "host", "ctx"} {
		if _, ok := rec[k]; !ok {
			t.Errorf("missing field %q in %v", k, rec)
		}
	}
	if rec["level"] != "info" {
		t.Errorf("level: got %v, want info", rec["level"])
	}
	if rec["lvl"].(float64) != 30 {
		t.Errorf("lvl: got %v, want 30", rec["lvl"])
	}
	if rec["msg"] != "feed poll failed" {
		t.Errorf("msg: got %v", rec["msg"])
	}
	// ctx carries the base app + per-call fields; err is lifted out.
	ctx := rec["ctx"].(map[string]any)
	if ctx["app"] != "rss-reader" {
		t.Errorf("ctx.app: got %v", ctx["app"])
	}
	if ctx["feedId"] != "f1" {
		t.Errorf("ctx.feedId: got %v", ctx["feedId"])
	}
	if _, hasErrInCtx := ctx["err"]; hasErrInCtx {
		t.Error("err should be lifted to top-level, not left in ctx")
	}
	errObj, ok := rec["err"].(map[string]any)
	if !ok || errObj["message"] != "boom" {
		t.Errorf("err object: got %v", rec["err"])
	}
	// ts is ISO-8601 with ms + Z.
	if ts, _ := rec["ts"].(string); !strings.HasSuffix(ts, "Z") || !strings.Contains(ts, ".") {
		t.Errorf("ts not ISO-8601-ms-Z: %q", ts)
	}
}

func TestLevelFiltering(t *testing.T) {
	var buf bytes.Buffer
	log := logger.New(logger.Config{Writer: &buf, Level: slog.LevelWarn})
	log.Info("suppressed")
	log.Warn("shown")
	out := buf.String()
	if strings.Contains(out, "suppressed") {
		t.Error("info logged below the warn threshold")
	}
	if !strings.Contains(out, "shown") {
		t.Error("warn not logged")
	}
}

func TestRotationFiresAtSizeCap(t *testing.T) {
	dir := t.TempDir()
	// 1 MB cap; write well past it so lumberjack rotates.
	log := logger.New(logger.Config{Dir: dir, Filename: "app", MaxSizeMB: 1, Level: slog.LevelInfo})
	big := strings.Repeat("x", 512)
	for i := 0; i < 4000; i++ { // ~4000 * (~600B line) ≈ 2.4 MB → at least one rotation
		log.Info("filler", "i", i, "pad", big)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var appFiles int
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "app") {
			appFiles++
		}
	}
	if appFiles < 2 {
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		t.Errorf("expected a rotated file (>=2 app* files), got %d: %v", appFiles, names)
	}
}
