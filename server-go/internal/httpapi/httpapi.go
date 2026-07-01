// Package httpapi assembles the HTTP layer: the chi router, middleware, and the
// /api/* handlers. Counterpart to server/app.ts + server/routes/*. Phase 3 wires
// the pure-read endpoints (no writes, no network); writes/auth/network land later.
package httpapi

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"math"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"rss-reader/server-go/internal/articles"
	"rss-reader/server-go/internal/model"
	"rss-reader/server-go/internal/store"
)

// Server carries the dependencies the handlers need.
type Server struct {
	DB *sql.DB
	// CacheReady mirrors cache.ts cacheReady in the all-articles/today envelope.
	// Wired to real startup warming in Phase 9; false until then (matches a
	// TEST_DB Node process, and is normalized out of the contract-diff anyway).
	CacheReady bool
}

// NewRouter builds the router with the read routes mounted.
func (s *Server) NewRouter() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	r.Get("/api/feeds", s.getFeeds)
	r.Get("/api/all-articles", s.getAllArticles)
	r.Get("/api/today", s.getToday)
	r.Get("/api/starred", s.getStarred)
	r.Get("/api/podcasts", s.getPodcasts)
	r.Get("/api/starred/count", s.getStarredCount)
	r.Get("/api/articles/{id}/content", s.getArticleContent)
	r.Get("/api/settings", s.getSettings)

	return r
}

func (s *Server) getFeeds(w http.ResponseWriter, _ *http.Request) {
	feeds, err := store.ListFeeds(s.DB)
	if err != nil {
		serverError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=30")
	writeJSON(w, http.StatusOK, feeds)
}

func (s *Server) getAllArticles(w http.ResponseWriter, r *http.Request) {
	arts, err := s.listArticles(r.URL.Query().Get("mode"), 0)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"articles":   articles.NormalizePubDates(arts),
		"cacheReady": s.CacheReady,
	})
}

func (s *Server) getToday(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	arts, err := s.listArticles(r.URL.Query().Get("mode"), midnight.UnixMilli())
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"articles":   articles.NormalizePubDates(arts),
		"cacheReady": s.CacheReady,
	})
}

// listArticles serves the shared all-articles/today body. since==0 means no time
// filter (all-articles); since>0 filters to pub_ts >= since (today).
func (s *Server) listArticles(mode string, since int64) ([]model.Article, error) {
	feedIDs, err := store.FeedIDs(s.DB)
	if err != nil {
		return nil, err
	}
	if mode == "digest" && len(feedIDs) > 0 {
		quota := digestQuota(len(feedIDs))
		arts := []model.Article{}
		for _, fid := range feedIDs {
			var rows []articles.Row
			if since > 0 {
				rows, err = store.SinceByFeed(s.DB, fid, since, quota)
			} else {
				rows, err = store.NewestByFeed(s.DB, fid, quota)
			}
			if err != nil {
				return nil, err
			}
			for _, row := range rows {
				arts = append(arts, articles.RowToArticle(row, false))
			}
		}
		articles.ByPubDateDesc(arts)
		if len(arts) > articles.ListLimit {
			arts = arts[:articles.ListLimit]
		}
		return arts, nil
	}
	var rows []articles.Row
	if since > 0 {
		rows, err = store.SinceGlobal(s.DB, since, articles.ListLimit)
	} else {
		rows, err = store.NewestGlobal(s.DB, articles.ListLimit)
	}
	if err != nil {
		return nil, err
	}
	return toArticles(rows, false), nil
}

func (s *Server) getStarred(w http.ResponseWriter, _ *http.Request) {
	rows, err := store.Starred(s.DB)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"articles": articles.NormalizePubDates(toArticles(rows, true)),
	})
}

func (s *Server) getPodcasts(w http.ResponseWriter, _ *http.Request) {
	rows, err := store.Podcasts(s.DB)
	if err != nil {
		serverError(w, err)
		return
	}
	arts := toArticles(rows, false)
	articles.ByPubDateDesc(arts)
	if len(arts) > 100 {
		arts = arts[:100]
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"articles": articles.NormalizePubDates(arts),
	})
}

func (s *Server) getStarredCount(w http.ResponseWriter, _ *http.Request) {
	n, err := store.StarredCount(s.DB)
	if err != nil {
		serverError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=10")
	writeJSON(w, http.StatusOK, map[string]any{"count": n})
}

func (s *Server) getArticleContent(w http.ResponseWriter, r *http.Request) {
	content, err := store.LookupContent(s.DB, chi.URLParam(r, "id"))
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"content": content})
}

func (s *Server) getSettings(w http.ResponseWriter, _ *http.Request) {
	settings, err := store.Settings(s.DB)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

// digestQuota splits LIST_LIMIT evenly across feeds (ceil), min 1.
func digestQuota(feedCount int) int {
	q := int(math.Ceil(float64(articles.ListLimit) / float64(feedCount)))
	if q < 1 {
		return 1
	}
	return q
}

// toArticles maps rows to Articles, always returning a non-nil slice so an empty
// result serializes as [] (not null), matching Express res.json([]).
func toArticles(rows []articles.Row, withContent bool) []model.Article {
	out := make([]model.Article, 0, len(rows))
	for _, r := range rows {
		out = append(out, articles.RowToArticle(r, withContent))
	}
	return out
}

// writeJSON encodes v with HTML escaping disabled so &, <, > pass through raw,
// matching Node's JSON.stringify / Express res.json.
func writeJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		serverError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(buf.Bytes())
}

func serverError(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
}
