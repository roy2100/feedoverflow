package httpapi

import (
	"net/http"
	"strconv"
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
	TitleZh       string `json:"titleZh"`
	Summary       string `json:"summary"`
	Content       string `json:"content"`
	Link          string `json:"link"`
	PubDate       string `json:"pubDate"`
	Author        string `json:"author"`
	AudioURL      string `json:"audioUrl"`
	AudioDuration string `json:"audioDuration"`
	IsStarred     bool   `json:"isStarred"`
}

// searchPageSize is one page of /api/search.
const searchPageSize = 100

// getSearch serves GET /api/search: q (one literal substring) plus optional
// scope/feedId, before (a date; only older articles), cursor (the previous page's
// next) and count=1 (adds total, which scans every row — the UI does not ask).
// Pages run newest first by (pub_ts, article_id); next is null on the last page.
// Rationale: docs/plan-search-paging.md.
func (s *Server) getSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"articles": []searchArticle{}, "query": q, "next": nil})
		return
	}
	opts := store.SearchOpts{
		Scope:  r.URL.Query().Get("scope"),
		FeedID: r.URL.Query().Get("feedId"),
		Limit:  searchPageSize + 1, // one extra row says whether a next page exists
	}
	if v := r.URL.Query().Get("before"); v != "" {
		t, ok := dates.ParsePubDate(v)
		if !ok {
			http.Error(w, "invalid before: "+v, http.StatusBadRequest)
			return
		}
		opts.Before = t.UnixMilli()
	}
	if v := r.URL.Query().Get("cursor"); v != "" {
		ts, id, ok := parseSearchCursor(v)
		if !ok {
			http.Error(w, "invalid cursor: "+v, http.StatusBadRequest)
			return
		}
		opts.AfterTs, opts.AfterID = ts, id
	}

	like := "%" + store.LikeEscape(q) + "%"
	hits, err := store.Search(s.DB.Reader(), like, opts)
	if err != nil {
		serverError(w, err)
		return
	}
	var next any // JSON null on the last page
	if len(hits) > searchPageSize {
		hits = hits[:searchPageSize]
		last := hits[len(hits)-1]
		next = strconv.FormatInt(last.PubTs, 10) + "_" + last.Row.ArticleID
	}

	arts := make([]searchArticle, 0, len(hits))
	for _, h := range hits {
		row := h.Row
		art := searchArticle{
			ID:            row.ArticleID,
			FeedID:        row.FeedID.String,
			FeedName:      row.FeedName.String,
			Title:         row.Title.String,
			TitleZh:       row.TitleZh.String,
			Summary:       utf16Slice(row.Summary.String, 300), // JS .slice(0,300)
			Content:       "",
			Link:          row.Link.String,
			PubDate:       row.PubDate.String,
			Author:        row.Author.String,
			AudioURL:      row.AudioURL.String,
			AudioDuration: row.AudioDuration.String,
			IsStarred:     row.IsStarred.Valid && row.IsStarred.Int64 != 0,
		}
		// normalizePubDates: rewrite each parseable pubDate to canonical ISO.
		if t, ok := dates.ParsePubDate(art.PubDate); ok {
			art.PubDate = dates.ISOString(t.UnixMilli())
		}
		arts = append(arts, art)
	}

	res := map[string]any{"articles": arts, "query": q, "next": next}
	if r.URL.Query().Get("count") == "1" {
		total, err := store.SearchCount(s.DB.Reader(), like, opts)
		if err != nil {
			serverError(w, err)
			return
		}
		res["total"] = total
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

// parseSearchCursor splits "<pub_ts>_<article_id>" (the next a page returned).
func parseSearchCursor(v string) (int64, string, bool) {
	tsPart, id, ok := strings.Cut(v, "_")
	if !ok || id == "" {
		return 0, "", false
	}
	ts, err := strconv.ParseInt(tsPart, 10, 64)
	if err != nil {
		return 0, "", false
	}
	return ts, id, true
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
