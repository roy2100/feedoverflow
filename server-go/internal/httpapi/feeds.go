package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"rss-reader/server-go/internal/articles"
	"rss-reader/server-go/internal/feed"
	"rss-reader/server-go/internal/feeds"
	"rss-reader/server-go/internal/httpx"
	"rss-reader/server-go/internal/store"
)

// postFeed is the port of POST /api/feeds: validate + dedupe the URL, parse the
// feed to derive its title, insert, then re-adopt any starred orphans left by a
// prior delete of the same URL.
func (s *Server) postFeed(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL  string `json:"url"`
		Name string `json:"name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.URL == "" {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "URL required"})
		return
	}
	// Reject a known dupe up front (idx_feeds_url is unique) with a clear message.
	exists, err := store.FeedURLExists(s.DB.Reader(), body.URL)
	if err != nil {
		serverError(w, err)
		return
	}
	if exists {
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{"error": "该 Feed 已存在"})
		return
	}

	resolved, err := store.ResolveURL(s.DB.Reader(), body.URL)
	if err != nil {
		serverError(w, err)
		return
	}
	parse := s.Parse
	if parse == nil {
		parse = feed.ParseURL
	}
	parsed, err := parse(r.Context(), resolved)
	if err != nil {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{
			"error":  "无法解析该 Feed，请检查 URL 是否正确",
			"detail": err.Error(),
		})
		return
	}
	// name (trimmed) || parsed.title (trimmed) || url.
	feedTitle := feeds.TrimName(body.Name)
	if feedTitle == "" {
		feedTitle = feeds.TrimName(parsed.Title)
	}
	if feedTitle == "" {
		feedTitle = body.URL
	}

	id := feeds.NewUUID()
	if err := store.InsertFeed(s.DB.Writer(), id, feedTitle, body.URL); err != nil {
		// Backstop for a concurrent-add race: the unique index trips the second
		// INSERT even though both passed the SELECT above. Surface as 409.
		if store.IsUniqueViolation(err) {
			httpx.WriteJSON(w, http.StatusConflict, map[string]any{"error": "该 Feed 已存在"})
			return
		}
		serverError(w, err)
		return
	}
	if _, err := store.AdoptStarredOrphans(s.DB.Writer(), id, feedTitle, body.URL); err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"id": id, "name": feedTitle, "url": body.URL})
}

// postImportOPML is the port of POST /api/feeds/import-opml: extract every feed
// from the OPML, skip URLs already present, insert the rest (adopting orphans),
// and report imported/skipped counts.
func (s *Server) postImportOPML(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OPML string `json:"opml"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.OPML == "" {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "opml content required"})
		return
	}
	candidates, err := feeds.ParseOPML([]byte(body.OPML))
	if err != nil {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{
			"error": "Failed to parse OPML", "detail": err.Error(),
		})
		return
	}
	existing, err := store.FeedURLSet(s.DB.Reader())
	if err != nil {
		serverError(w, err)
		return
	}
	imported := []map[string]any{}
	skipped := 0
	for _, c := range candidates {
		if existing[c.URL] {
			skipped++
			continue
		}
		id := feeds.NewUUID()
		if err := store.InsertFeedIgnore(s.DB.Writer(), id, c.Name, c.URL); err != nil {
			serverError(w, err)
			return
		}
		if _, err := store.AdoptStarredOrphans(s.DB.Writer(), id, c.Name, c.URL); err != nil {
			serverError(w, err)
			return
		}
		imported = append(imported, map[string]any{"id": id, "name": c.Name, "url": c.URL})
		existing[c.URL] = true
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"imported": len(imported), "skipped": skipped, "feeds": imported,
	})
}

// patchFeed is PATCH /api/feeds/:id: rename a feed and/or flip its push opt-in
// (404 if missing). Both fields are optional pointers so each is only applied
// when the client actually sent it — a rename-only body (the original contract,
// still what the MCP rename_feed tool sends) must not clear push_enabled, and a
// push-only body must not have to echo the name back.
func (s *Server) patchFeed(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        *string `json:"name"`
		PushEnabled *bool   `json:"push_enabled"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Name == nil && body.PushEnabled == nil {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "name required"})
		return
	}
	id := chi.URLParam(r, "id")

	if body.Name != nil {
		// feeds.name is NOT NULL, so an empty rename must be rejected up front rather
		// than reaching the UPDATE (which would 500 on the constraint).
		name := strings.TrimSpace(*body.Name)
		if name == "" {
			httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "name required"})
			return
		}
		changes, err := store.RenameFeed(s.DB.Writer(), id, name)
		if err != nil {
			serverError(w, err)
			return
		}
		if changes == 0 {
			httpx.WriteJSON(w, http.StatusNotFound, map[string]any{"error": "Not found"})
			return
		}
	}

	if body.PushEnabled != nil {
		// Enabling seeds the notification watermark to now (store.SetFeedPush), so
		// switching push on never replays the feed's existing backlog.
		changes, err := store.SetFeedPush(s.DB.Writer(), id, *body.PushEnabled, time.Now().UnixMilli())
		if err != nil {
			serverError(w, err)
			return
		}
		if changes == 0 {
			httpx.WriteJSON(w, http.StatusNotFound, map[string]any{"error": "Not found"})
			return
		}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// deleteFeed is the port of DELETE /api/feeds/:id: remove the feed + purge its
// non-starred articles (starred kept), 404 if missing.
func (s *Server) deleteFeed(w http.ResponseWriter, r *http.Request) {
	changes, err := store.DeleteFeed(s.DB.Writer(), chi.URLParam(r, "id"))
	if err != nil {
		serverError(w, err)
		return
	}
	if changes == 0 {
		httpx.WriteJSON(w, http.StatusNotFound, map[string]any{"error": "Not found"})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// getFeedArticles is the port of GET /api/feeds/:id/articles: ensure freshness,
// then serve the feed's newest LIST_LIMIT rows straight from article_states.
func (s *Server) getFeedArticles(w http.ResponseWriter, r *http.Request) {
	f, ok, err := store.GetFeed(s.DB.Reader(), chi.URLParam(r, "id"))
	if err != nil {
		serverError(w, err)
		return
	}
	if !ok {
		httpx.WriteJSON(w, http.StatusNotFound, map[string]any{"error": "Not found"})
		return
	}
	if err := s.Cache.EnsureFresh(r.Context(), f); err != nil {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]any{
			"error": "Failed to fetch feed", "detail": err.Error(),
		})
		return
	}
	rows, err := store.NewestByFeed(s.DB.Reader(), f.ID, articles.ListLimit)
	if err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"feedName": f.Name,
		"articles": articles.NormalizePubDates(toArticles(rows, false)),
	})
}
