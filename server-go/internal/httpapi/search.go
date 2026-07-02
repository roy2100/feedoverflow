package httpapi

import (
	"net/http"
	"sort"
	"strings"
	"unicode/utf16"

	"rss-reader/server-go/internal/dates"
	"rss-reader/server-go/internal/httpx"
	"rss-reader/server-go/internal/store"
)

// searchArticle is the search result shape. It deliberately omits updatedAt (the
// Node handler builds the object literal without it, unlike rowToArticle), so the
// wire JSON has no updatedAt key.
type searchArticle struct {
	ID            string `json:"id"`
	FeedID        string `json:"feedId"`
	FeedName      string `json:"feedName"`
	Title         string `json:"title"`
	Summary       string `json:"summary"`
	Content       string `json:"content"`
	Link          string `json:"link"`
	PubDate       string `json:"pubDate"`
	Author        string `json:"author"`
	AudioURL      string `json:"audioUrl"`
	AudioDuration string `json:"audioDuration"`
	IsStarred     bool   `json:"isStarred"`
}

// likeEscaper escapes the LIKE metacharacters, matching q.replace(/[\\%_]/g,'\\$&').
// Backslash is escaped first; NewReplacer's single non-overlapping pass makes the
// order among the three safe.
var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// getSearch is the port of GET /api/search.
func (s *Server) getSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	// q.length in JS is a UTF-16 code-unit count.
	if utf16Len(q) < 2 {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"articles": []searchArticle{}, "query": q})
		return
	}
	scope := r.URL.Query().Get("scope")
	feedID := r.URL.Query().Get("feedId")

	like := "%" + likeEscaper.Replace(q) + "%"
	rows, err := store.Search(s.DB.Reader(), like, scope, feedID)
	if err != nil {
		serverError(w, err)
		return
	}

	arts := make([]searchArticle, 0, len(rows))
	for _, row := range rows {
		arts = append(arts, searchArticle{
			ID:            row.ArticleID,
			FeedID:        row.FeedID.String,
			FeedName:      row.FeedName.String,
			Title:         row.Title.String,
			Summary:       utf16Slice(row.Summary.String, 300), // JS .slice(0,300)
			Content:       "",
			Link:          row.Link.String,
			PubDate:       row.PubDate.String,
			Author:        row.Author.String,
			AudioURL:      row.AudioURL.String,
			AudioDuration: row.AudioDuration.String,
			IsStarred:     row.IsStarred.Valid && row.IsStarred.Int64 != 0,
		})
	}
	// Re-sort by parsed publish date desc (byPubDateDesc: unparseable → 0), then
	// slice to 100. Stable so equal-date rows keep the SQL text order.
	sort.SliceStable(arts, func(i, j int) bool {
		return dates.PubTs(arts[i].PubDate, 0) > dates.PubTs(arts[j].PubDate, 0)
	})
	if len(arts) > 100 {
		arts = arts[:100]
	}
	// normalizePubDates: rewrite each parseable pubDate to canonical ISO.
	for i := range arts {
		if t, ok := dates.ParsePubDate(arts[i].PubDate); ok {
			arts[i].PubDate = dates.ISOString(t.UnixMilli())
		}
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{"articles": arts, "query": q})
}

// utf16Len counts UTF-16 code units (JS string .length).
func utf16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}

// utf16Slice returns the first n UTF-16 code units of s, decoded back to a string,
// reproducing JS str.slice(0, n) (which indexes by UTF-16 code unit).
func utf16Slice(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}
