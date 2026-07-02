// Package crash routes an otherwise-silent panic through the shared structured
// logger. Go panics do not cross goroutine boundaries, so a panic in a background
// worker crashes the whole process with only a stderr stack trace — never
// reaching app.log. Deferring one of these captures the panic and logs it as a
// structured NDJSON record with the stack.
//
// Two policies:
//   - Guard  — log a fatal record, then exit(1). For main, the network listeners,
//     and startup: places where the process cannot sensibly continue. launchd's
//     KeepAlive then restarts a clean process (the Go analogue of Node's
//     uncaughtException handler).
//   - Recover — log an error record, then carry on. For one unit of background
//     work (a poll cycle, a single feed refresh, a maintenance pass): one poisoned
//     iteration must not kill a long-lived worker or the whole process. This
//     mirrors net/http's per-request recovery.
//
// Separation of concerns: the logger package only logs; the exit decision lives here.
package crash

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"runtime/debug"

	"rss-reader/server-go/internal/logger"
)

// Guard, deferred at the top of a goroutine (or main), logs a recovered panic as a
// structured fatal record and exits(1). name identifies the goroutine in the log.
// No-op when there is no panic.
func Guard(l *slog.Logger, name string) {
	if r := recover(); r != nil {
		logPanic(l, logger.LevelFatal, "uncaught panic", name, r)
		os.Exit(1)
	}
}

// Recover, deferred around one unit of background work, logs a recovered panic at
// error level (with stack) and lets the caller continue. name identifies the work
// in the log. No-op when there is no panic.
func Recover(l *slog.Logger, name string) {
	if r := recover(); r != nil {
		logPanic(l, slog.LevelError, "recovered panic", name, r)
	}
}

// logPanic emits the shared panic record. A recovered value that is already an
// error keeps its type/chain (serializeError lifts it to top-level err);
// otherwise it is wrapped with %v.
func logPanic(l *slog.Logger, level slog.Level, msg, name string, r any) {
	err, ok := r.(error)
	if !ok {
		err = fmt.Errorf("%v", r)
	}
	l.Log(context.Background(), level, msg,
		"goroutine", name,
		"err", err,
		"stack", string(debug.Stack()),
	)
}
