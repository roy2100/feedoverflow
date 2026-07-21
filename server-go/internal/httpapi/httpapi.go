// Package httpapi assembles the HTTP layer: the chi routers, middleware, and the
// /api/* handlers. Counterpart to server/app.ts + server/routes/*.
//
// Two routers share the same API routes (mountAPIRoutes):
//   - Public (NewPublicRouter): CORS + auth gate; served on all interfaces.
//   - Loopback (NewLocalRouter): no auth; bound to 127.0.0.1 only. The socket, not
//     a header, decides whether auth applies. Also mounts /mcp (internal/mcp),
//     the Streamable HTTP MCP server — never on the public router.
//
// Reads go through the DB read pool; writes through the single-writer pool.
package httpapi

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"rss-reader/server-go/internal/articles"
	"rss-reader/server-go/internal/auth"
	"rss-reader/server-go/internal/cache"
	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/favicon"
	"rss-reader/server-go/internal/httpx"
	"rss-reader/server-go/internal/mcp"
	"rss-reader/server-go/internal/model"
	"rss-reader/server-go/internal/push"
	"rss-reader/server-go/internal/store"
)

var allowedOrigins = map[string]bool{
	"http://localhost:3000": true,
	"https://rss.royl.uk":   true,
	"https://rss.lan":       true,
}

// Server carries the dependencies the handlers need.
type Server struct {
	DB *db.DB
	// Cache is the fetch scheduler (Phase 6). ensureFresh runs before serving a
	// feed's rows (GET /api/feeds/:id/articles).
	Cache *cache.Cache
	// Parse resolves+parses a feed URL for POST /api/feeds (which parses directly,
	// not through the cache, matching Node). nil → feed.ParseURL; injectable in
	// tests to avoid the network.
	Parse cache.FetchFunc
	// Favicon is the read-through favicon cache (GET /api/favicon).
	Favicon *favicon.Cache
	// Push owns the VAPID keypair the subscribe flow needs. nil disables the
	// /api/push/* routes (they answer 503) and, in jobs.Runner, notifications.
	Push *push.Sender
	// AuthUser/AuthPass gate the public listener when both are set (auth disabled
	// otherwise), matching registerAuth.
	AuthUser string
	AuthPass string
	// DistDir is the client/dist directory served on the public listener (static
	// assets + SPA fallback). Empty disables static serving (loopback listener
	// never serves it).
	DistDir string
	// LocalAPIPort is the loopback listener's own port. The MCP server's tools
	// call back into the API over 127.0.0.1:LocalAPIPort (see internal/mcp),
	// same self-call pattern as the Node original.
	LocalAPIPort int
	// CacheReady mirrors cache.ts cacheReady in the all-articles/today envelope.
	// When a Cache is present its warming state wins (see cacheReady); this field
	// is the fallback for tests/servers without a Cache. Normalized out of the
	// contract-diff either way.
	CacheReady bool

	// In-memory "currently open" article (GET|POST /api/current-article). nil = none.
	curMu      sync.Mutex
	curArticle json.RawMessage
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
	// Static assets + SPA fallback for any unmatched non-/api path (public only).
	if s.DistDir != "" {
		r.NotFound(s.spaFallback)
	}
	return r
}

// NewLocalRouter builds the loopback-only router: no auth, no CORS, no SPA.
func (s *Server) NewLocalRouter() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(apiNoStore)
	r.Get("/healthz", healthz)
	s.mountAPIRoutes(r)
	r.Handle("/mcp", mcp.Handler(s.LocalAPIPort))
	return r
}

// mountAPIRoutes registers the shared /api routes on r.
func (s *Server) mountAPIRoutes(r chi.Router) {
	r.Get("/api/feeds", s.getFeeds)
	r.Post("/api/feeds", s.postFeed)
	r.Post("/api/feeds/import-opml", s.postImportOPML)
	r.Patch("/api/feeds/{id}", s.patchFeed)
	r.Delete("/api/feeds/{id}", s.deleteFeed)
	r.Get("/api/feeds/{id}/articles", s.getFeedArticles)
	r.Get("/api/all-articles", s.getAllArticles)
	r.Get("/api/today", s.getToday)
	r.Get("/api/starred", s.getStarred)
	r.Get("/api/podcasts", s.getPodcasts)
	r.Get("/api/starred/count", s.getStarredCount)
	r.Post("/api/articles/star", s.postStar)
	r.Get("/api/articles/{id}/content", s.getArticleContent)
	r.Get("/api/search", s.getSearch)
	r.Get("/api/fetch-content", s.getFetchContent)
	r.Get("/api/favicon", s.getFaviconRoute)
	r.Get("/api/settings", s.getSettings)
	r.Patch("/api/settings", s.patchSettings)
	r.Get("/api/current-article", s.getCurrentArticle)
	r.Post("/api/current-article", s.postCurrentArticle)
	r.Get("/api/push/key", s.getPushKey)
	r.Post("/api/push/subscribe", s.postPushSubscribe)
	r.Post("/api/push/unsubscribe", s.postPushUnsubscribe)
}

// cacheReady reports the warming state for the all-articles/today envelope: the
// live Cache's warming flag when present, else the static CacheReady fallback.
func (s *Server) cacheReady() bool {
	if s.Cache != nil {
		return s.Cache.Ready()
	}
	return s.CacheReady
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
		if strings.HasPrefix(r.URL.Path, "/api") {
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
	feeds, err := store.ListFeeds(s.DB.Reader())
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
		"cacheReady": s.cacheReady(),
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
		"cacheReady": s.cacheReady(),
	})
}

// listArticles serves the shared all-articles/today body. since==0 means no time
// filter (all-articles); since>0 filters to pub_ts >= since (today).
func (s *Server) listArticles(mode string, since int64) ([]model.Article, error) {
	rdb := s.DB.Reader()
	feedIDs, err := store.FeedIDs(rdb)
	if err != nil {
		return nil, err
	}
	if mode == "digest" && len(feedIDs) > 0 {
		quota := digestQuota(len(feedIDs))
		arts := []model.Article{}
		for _, fid := range feedIDs {
			var rows []articles.Row
			if since > 0 {
				rows, err = store.SinceByFeed(rdb, fid, since, quota)
			} else {
				rows, err = store.NewestByFeed(rdb, fid, quota)
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
		rows, err = store.SinceGlobal(rdb, since, articles.ListLimit)
	} else {
		rows, err = store.NewestGlobal(rdb, articles.ListLimit)
	}
	if err != nil {
		return nil, err
	}
	return toArticles(rows, false), nil
}

func (s *Server) getStarred(w http.ResponseWriter, _ *http.Request) {
	rows, err := store.Starred(s.DB.Reader())
	if err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"articles": articles.NormalizePubDates(toArticles(rows, true)),
	})
}

func (s *Server) getPodcasts(w http.ResponseWriter, _ *http.Request) {
	rows, err := store.Podcasts(s.DB.Reader())
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
	n, err := store.StarredCount(s.DB.Reader())
	if err != nil {
		serverError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=10")
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"count": n})
}

func (s *Server) getArticleContent(w http.ResponseWriter, r *http.Request) {
	content, err := store.LookupContent(s.DB.Reader(), chi.URLParam(r, "id"))
	if err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": content})
}

// postStar is the port of POST /api/articles/star: upsert is_starred, filling
// content from the DB when the client omits it. Never clobbers title/summary/etc.
func (s *Server) postStar(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Article model.Article `json:"article"`
		Starred bool          `json:"starred"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Article.ID == "" {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "article required"})
		return
	}
	if body.Article.Content == "" {
		if c, err := store.LookupContent(s.DB.Reader(), body.Article.ID); err == nil {
			body.Article.Content = c
		}
	}
	isStarred := 0
	if body.Starred {
		isStarred = 1
	}
	if err := store.SaveState(s.DB.Writer(), body.Article, isStarred, time.Now().UnixMilli()); err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "isStarred": body.Starred})
}

func (s *Server) getSettings(w http.ResponseWriter, _ *http.Request) {
	settings, err := store.Settings(s.DB.Reader())
	if err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, settings)
}

// patchSettings is the port of PATCH /api/settings: upsert the allowed keys, then
// clear feed freshness so the next read re-fetches.
func (s *Server) patchSettings(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		body = map[string]any{}
	}
	for _, key := range []string{"rsshub_base_url"} {
		if v, ok := body[key]; ok {
			if err := store.UpdateSetting(s.DB.Writer(), key, strings.TrimSpace(fmt.Sprint(v))); err != nil {
				serverError(w, err)
				return
			}
		}
	}
	if err := store.ClearFeedFreshness(s.DB.Writer()); err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) getCurrentArticle(w http.ResponseWriter, _ *http.Request) {
	s.curMu.Lock()
	cur := s.curArticle
	s.curMu.Unlock()
	if cur == nil {
		httpx.WriteJSON(w, http.StatusNotFound, map[string]any{"error": "no article open"})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(cur)
}

func (s *Server) postCurrentArticle(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Article json.RawMessage `json:"article"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	s.curMu.Lock()
	if len(body.Article) == 0 || string(body.Article) == "null" {
		s.curArticle = nil
	} else {
		s.curArticle = body.Article
	}
	s.curMu.Unlock()
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
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
