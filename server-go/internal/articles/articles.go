// Package articles holds the parity-critical domain core: article-id derivation
// and small pure helpers. Port of the pure functions in server/articles.ts.
//
// enrich(), rowToArticle(), persistItems(), and the DB-backed helpers depend on
// shared types + the DB and are ported in Phase 3/5/6 alongside their call sites.
// Phase 2 gates on the hashing/date parity (makeId + package dates), which is
// what determines whether re-fetches dedup correctly against the existing DB.
package articles

import (
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
)

// LIST_LIMIT — shared cap for the article-list endpoints (see articles.ts).
const ListLimit = 500

// reClock matches a clock-style duration (h:mm or h:mm:ss), mirroring
// /^\d+:\d{2}(:\d{2})?$/ in normalizeDuration.
var reClock = regexp.MustCompile(`^\d+:\d{2}(:\d{2})?$`)

// MakeID reproduces makeId: md5(link || `${title}${pubDate}`) hex, first 12 chars.
// JS `||` treats empty string as falsy, so an empty link falls back to title+pubDate.
// Every production row has a link, so in practice this is md5(link)[:12]; the
// fallback branch exists only for link-less items.
func MakeID(link, title, pubDate string) string {
	seed := link
	if seed == "" {
		seed = title + pubDate
	}
	sum := md5.Sum([]byte(seed))
	return hex.EncodeToString(sum[:])[:12]
}

// NormalizeDuration is the port of normalizeDuration: passes through a clock-style
// duration, converts a bare seconds count to h:mm:ss / m:ss, else returns as-is.
func NormalizeDuration(dur string) string {
	if dur == "" {
		return ""
	}
	if reClock.MatchString(dur) {
		return dur
	}
	// parseInt(dur, 10): leading integer, ignoring trailing junk; NaN if none.
	secs, ok := parseLeadingInt(dur)
	if !ok {
		return dur
	}
	h := secs / 3600
	m := (secs % 3600) / 60
	s := secs % 60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%d:%02d", m, s)
}

// parseLeadingInt mirrors JS parseInt(s, 10): parse an optional sign + leading
// digits, ignoring the rest; ok=false when there is no leading integer.
func parseLeadingInt(s string) (int, bool) {
	i := 0
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	start := i
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == start {
		return 0, false
	}
	n, err := strconv.Atoi(s[:i])
	if err != nil {
		return 0, false
	}
	return n, true
}
