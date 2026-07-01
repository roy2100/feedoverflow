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
	"database/sql"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strconv"

	"rss-reader/server-go/internal/dates"
	"rss-reader/server-go/internal/model"
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

// Row is a scanned article_states row (the columns rowToArticle needs). Nullable
// columns use sql.Null* — feed_id/feed_name/title/link/pub_date/summary/content/
// author are never NULL in the data but scanned as NullString defensively.
type Row struct {
	ArticleID        string
	FeedID           sql.NullString
	FeedName         sql.NullString
	Title            sql.NullString
	Link             sql.NullString
	PubDate          sql.NullString
	Summary          sql.NullString
	Content          sql.NullString
	Author           sql.NullString
	AudioURL         sql.NullString
	AudioDuration    sql.NullString
	IsStarred        sql.NullInt64 // NULL in some rows; Node's !!r.is_starred treats it as false
	ContentUpdatedAt sql.NullInt64
}

// RowToArticle is the port of rowToArticle. List endpoints pass withContent=false
// to strip summary+content; starred reads pass true. updatedAt is content_updated_at
// (nil → JSON null). Fields Node emits without `|| ”` (feedId/feedName/title/link/
// pubDate) are non-NULL in the data, so their string value is exact.
func RowToArticle(r Row, withContent bool) model.Article {
	a := model.Article{
		ID:            r.ArticleID,
		FeedID:        r.FeedID.String,
		FeedName:      r.FeedName.String,
		Title:         r.Title.String,
		Link:          r.Link.String,
		PubDate:       r.PubDate.String,
		Author:        r.Author.String,
		AudioURL:      r.AudioURL.String,
		AudioDuration: r.AudioDuration.String,
		IsStarred:     r.IsStarred.Valid && r.IsStarred.Int64 != 0,
	}
	if withContent {
		a.Summary = r.Summary.String
		a.Content = r.Content.String
	}
	if r.ContentUpdatedAt.Valid {
		v := r.ContentUpdatedAt.Int64
		a.UpdatedAt = &v
	}
	return a
}

// pubMs is the sort key: parsed publish ms, else 0 (unparseable sinks to bottom).
func pubMs(pubDate string) int64 {
	if t, ok := dates.ParsePubDate(pubDate); ok {
		return t.UnixMilli()
	}
	return 0
}

// ByPubDateDesc stable-sorts newest-first by parsed pub_date, mirroring
// byPubDateDesc + V8's stable Array.sort (ties keep input order).
func ByPubDateDesc(arts []model.Article) {
	sort.SliceStable(arts, func(i, j int) bool {
		return pubMs(arts[i].PubDate) > pubMs(arts[j].PubDate)
	})
}

// NormalizePubDates rewrites each parseable pubDate to canonical ISO-8601 in place,
// leaving unparseable strings untouched — the port of normalizePubDates.
func NormalizePubDates(arts []model.Article) []model.Article {
	for i := range arts {
		if t, ok := dates.ParsePubDate(arts[i].PubDate); ok {
			arts[i].PubDate = dates.ISOString(t.UnixMilli())
		}
	}
	return arts
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
