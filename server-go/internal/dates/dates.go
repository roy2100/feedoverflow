// Package dates is the Go port of server/dates.ts: the single source of truth for
// turning an RSS pubDate string into an instant. It must reproduce the exact epoch
// value the Node build produced, because pub_ts drives list ordering and (via
// makeId's fallback) can feed article-id derivation.
//
// Parity notes:
//   - Node uses `new Date(str)` (V8's lenient parser). Go has no universal parser,
//     so we try an ordered list of layouts covering every format present in the
//     production DB, mirroring V8's result for those inputs (validated by a golden
//     test against the real dates.ts over all distinct pub_date values).
//   - Timezone-less inputs are interpreted in the process-local zone, exactly like
//     `new Date()`. The server runs in Asia/Shanghai; the deployed binary must run
//     with the same TZ (launchd inherits it) or these instants shift.
//   - ISOString derives from the epoch-ms value, like JS `toISOString()`, so it is
//     always UTC with 3-digit milliseconds.
package dates

import (
	"regexp"
	"strings"
	"time"
)

// Layouts tried (in order) against both the raw and the normalized string. Zoned
// layouts win when an offset/zone is present; the bare (zoneless) layouts are
// parsed in time.Local to match `new Date()`.
var zonedLayouts = []string{
	time.RFC3339Nano,                  // 2006-01-02T15:04:05.999999999Z07:00
	time.RFC3339,                      // 2006-01-02T15:04:05Z07:00
	"Mon, 02 Jan 2006 15:04:05 -0700", // RFC822 numeric offset
	"Mon, 02 Jan 2006 15:04:05 MST",   // RFC822 named zone (GMT/UTC)
	"02 Jan 2006 15:04:05 -0700",      // RFC822 without weekday
	"02 Jan 2006 15:04:05 MST",        //
	"2006-01-02T15:04:05-0700",        // ISO-ish, colon-less offset
	"2006-01-02 15:04:05 -0700",       // space-separated with offset
	"2006-01-02 15:04:05 -07:00",      //
}

var localLayouts = []string{
	"2006-01-02T15:04:05.000",   // ISO no zone, with ms
	"2006-01-02T15:04:05",       // ISO no zone
	"2006-01-02 15:04:05",       // space-separated, no zone
	"Mon, 02 Jan 2006 15:04:05", // RFC822 no zone
	"02 Jan 2006 15:04:05",      // RFC822 no weekday, no zone
	"2006-01-02",                // bare date (midnight local)
}

var (
	reWhitespace = regexp.MustCompile(`\s+`)
	reDateSpace  = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}) `)
	reOffset     = regexp.MustCompile(` ?([+-]\d{2})(\d{2})$`)
)

// ParsePubDate returns the parsed instant and true, or (zero, false) when the
// string is empty/unparseable — the port of parsePubDate (null → false).
func ParsePubDate(dateStr string) (time.Time, bool) {
	if dateStr == "" {
		return time.Time{}, false
	}
	if t, ok := tryLayouts(dateStr); ok {
		return t, true
	}
	// Normalize (same three rewrites as dates.ts) and retry.
	n := reWhitespace.ReplaceAllString(strings.TrimSpace(dateStr), " ")
	n = reDateSpace.ReplaceAllString(n, "${1}T")
	n = reOffset.ReplaceAllString(n, "${1}:${2}")
	if n != dateStr {
		if t, ok := tryLayouts(n); ok {
			return t, true
		}
	}
	return time.Time{}, false
}

func tryLayouts(s string) (time.Time, bool) {
	for _, l := range zonedLayouts {
		if t, err := time.Parse(l, s); err == nil {
			return t, true
		}
	}
	for _, l := range localLayouts {
		if t, err := time.ParseInLocation(l, s, time.Local); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// PubTs is the port of pubTs: parsed epoch-ms, else the fallback.
func PubTs(pubDate string, fallback int64) int64 {
	if t, ok := ParsePubDate(pubDate); ok {
		return t.UnixMilli()
	}
	return fallback
}

// ISOString reproduces JS Date.toISOString() for an epoch-ms value: UTC, always
// three-digit milliseconds, trailing Z.
func ISOString(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z07:00")
}
