// Package httpapi assembles the HTTP layer: the chi routers, middleware, and the
// /api/* handlers. Counterpart to server/app.ts + server/routes/*.
//
// Two routers share the same API routes (mountAPIRoutes):
//   - Public (NewPublicRouter): CORS + auth gate; served on all interfaces.
//   - Loopback (NewLocalRouter): no auth; bound to 127.0.0.1 only. The socket, not
//     a header, decides whether auth applies.
//
// Static/SPA serving and MCP are out of this phase (SPA is Phase 10; MCP is out of
// scope for the migration).
package httpapi

import (
	"database/sql"
	"math"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"rss-reader/server-go/internal/articles"
	"rss-reader/server-go/internal/auth"
	"rss-reader/server-go/internal/httpx"
	"rss-reader/server-go/internal/model"
	"rss-reader/server-go/internal/store"
)

var allowedOrigins = map[string]bool{
	"http://localhost:3000": true,
	"https://rss.royl.uk":   true,
	"https://rss.lan":       true,
}

// Server carries the dependencies the handlers need.
type Server struct {
	DB *sql.DB
	// AuthUser/AuthPass gate the public listener when both are set (auth disabled
	// otherwise), matching registerAuth.
	AuthUser string
	AuthPass string
	// CacheReady mirrors cache.ts cacheReady in the all-articles/today envelope
	// (wired to real warming in Phase 9; normalized out of the contract-diff).
	CacheReady bool
}

// NewPublicRouter builds the public, auth-gated router (CORS enabled).
func (s *Server) NewPublicRouter() http.Handler {
	a := auth.New(s.DB, s.AuthUser, s.AuthPass)
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware)
	r.Use(apiNoStore)
	r.Use(a.Gate) // must precede any route (chi requirement)
	r.Get("/healthz", healthz)
	a.RegisterRoutes(r)
	s.mountAPIRoutes(r)
	return r
}

// NewLocalRouter builds the loopback-only router: no auth, no CORS, no SPA.
func (s *Server) NewLocalRouter() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(apiNoStore)
	r.Get("/healthz", healthz)
	s.mountAPIRoutes(r)
	return r
}

// mountAPIRoutes registers the shared /api routes on r.
func (s *Server) mountAPIRoutes(r chi.Router) {
	r.Get("/api/feeds", s.getFeeds)
	r.Get("/api/all-articles", s.getAllArticles)
	r.Get("/api/today", s.getToday)
	r.Get("/api/starred", s.getStarred)
	r.Get("/api/podcasts", s.getPodcasts)
	r.Get("/api/starred/count", s.getStarredCount)
	r.Get("/api/articles/{id}/content", s.getArticleContent)
	r.Get("/api/settings", s.getSettings)
}

func healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// apiNoStore sets Cache-Control: no-store on /api responses (app.use('/api',
// noStore)). Handlers that set their own Cache-Control override it afterward.
func apiNoStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.URL.Path) >= 4 && r.URL.Path[:4] == "/api" {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// corsMiddleware mirrors cors({ origin: ALLOWED_ORIGINS, credentials: true }).
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && allowedOrigins[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Add("Vary", "Origin")
			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE")
				if h := r.Header.Get("Access-Control-Request-Headers"); h != "" {
					w.Header().Set("Access-Control-Allow-Headers", h)
				}
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) getFeeds(w http.ResponseWriter, _ *http.Request) {
	feeds, err := store.ListFeeds(s.DB)
	if err != nil {
		serverError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=30")
	httpx.WriteJSON(w, http.StatusOK, feeds)
}

func (s *Server) getAllArticles(w http.ResponseWriter, r *http.Request) {
	arts, err := s.listArticles(r.URL.Query().Get("mode"), 0)
	if err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
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
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
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
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
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
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
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
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"count": n})
}

func (s *Server) getArticleContent(w http.ResponseWriter, r *http.Request) {
	content, err := store.LookupContent(s.DB, chi.URLParam(r, "id"))
	if err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": content})
}

func (s *Server) getSettings(w http.ResponseWriter, _ *http.Request) {
	settings, err := store.Settings(s.DB)
	if err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, settings)
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

func serverError(w http.ResponseWriter, err error) {
	httpx.WriteJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
}
