package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"rss-reader/server-go/internal/articles"
	"rss-reader/server-go/internal/feeds"
	"rss-reader/server-go/internal/httpx"
	"rss-reader/server-go/internal/model"
	"rss-reader/server-go/internal/store"
)

// Collections are saved queries over article_states — a way to read several feeds
// (optionally narrowed by keyword) as one stream. They fetch nothing: no cache
// entry, no poller slot, no freshness handling, exactly like /api/all-articles,
// which also serves straight from the table and lets the poller keep it current.
// Rationale: docs/plan-collections.md.

// collectionBody is the create/update payload. Both fields are pointers on PATCH
// so each is applied only when actually sent — a rename must not silently wipe
// the rules, the same contract patchFeed uses for name/push_enabled.
type collectionBody struct {
	Name  *string       `json:"name"`
	Rules *[]store.Rule `json:"rules"`
}

func (s *Server) getCollections(w http.ResponseWriter, _ *http.Request) {
	cols, err := store.ListCollections(s.DB.Reader())
	if err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, cols)
}

// normalizeRules trims every rule and drops the ones that constrain nothing. It
// returns an error message when the result is empty: a collection with no usable
// rule would render as a permanently blank list with no hint why.
func normalizeRules(in []store.Rule) ([]store.Rule, string) {
	out := make([]store.Rule, 0, len(in))
	for _, r := range in {
		n := r.Normalized()
		if n.Valid() {
			out = append(out, n)
		}
	}
	if len(out) == 0 {
		return nil, "每条规则至少要指定一个订阅源或关键词"
	}
	return out, ""
}

func (s *Server) postCollection(w http.ResponseWriter, r *http.Request) {
	var body collectionBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	name := ""
	if body.Name != nil {
		name = strings.TrimSpace(*body.Name)
	}
	if name == "" {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "name required"})
		return
	}
	if body.Rules == nil {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "rules required"})
		return
	}
	rules, msg := normalizeRules(*body.Rules)
	if msg != "" {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": msg})
		return
	}

	id := feeds.NewUUID()
	if err := store.InsertCollection(s.DB.Writer(), id, name, rules, time.Now().UnixMilli()); err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, store.Collection{ID: id, Name: name, Rules: rules})
}

func (s *Server) patchCollection(w http.ResponseWriter, r *http.Request) {
	var body collectionBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Name == nil && body.Rules == nil {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "name or rules required"})
		return
	}
	id := chi.URLParam(r, "id")

	// Validate the rules before writing anything, so a bad rule set can't land a
	// rename and then 400.
	var rules []store.Rule
	if body.Rules != nil {
		var msg string
		rules, msg = normalizeRules(*body.Rules)
		if msg != "" {
			httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": msg})
			return
		}
	}

	if body.Name != nil {
		name := strings.TrimSpace(*body.Name)
		if name == "" {
			httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "name required"})
			return
		}
		changes, err := store.RenameCollection(s.DB.Writer(), id, name)
		if err != nil {
			serverError(w, err)
			return
		}
		if changes == 0 {
			httpx.WriteJSON(w, http.StatusNotFound, map[string]any{"error": "Not found"})
			return
		}
	}
	if body.Rules != nil {
		// A rules-only PATCH still has to 404 on an unknown id; the rename above
		// does its own check, so only look when it didn't run.
		if body.Name == nil {
			_, ok, err := store.GetCollection(s.DB.Reader(), id)
			if err != nil {
				serverError(w, err)
				return
			}
			if !ok {
				httpx.WriteJSON(w, http.StatusNotFound, map[string]any{"error": "Not found"})
				return
			}
		}
		if err := store.ReplaceRules(s.DB.Writer(), id, rules); err != nil {
			serverError(w, err)
			return
		}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) deleteCollection(w http.ResponseWriter, r *http.Request) {
	changes, err := store.DeleteCollection(s.DB.Writer(), chi.URLParam(r, "id"))
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

// getCollectionArticles serves one collection's stream: the union of its rules,
// newest first.
func (s *Server) getCollectionArticles(w http.ResponseWriter, r *http.Request) {
	c, ok, err := store.GetCollection(s.DB.Reader(), chi.URLParam(r, "id"))
	if err != nil {
		serverError(w, err)
		return
	}
	if !ok {
		httpx.WriteJSON(w, http.StatusNotFound, map[string]any{"error": "Not found"})
		return
	}
	arts, err := s.collectionArticles(c, wantSummary(r))
	if err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"name":     c.Name,
		"articles": articles.NormalizePubDates(arts),
	})
}

// collectionArticles runs one query per rule and merges the results — the same
// fan-out/merge shape listArticles already uses for digest mode, which keeps the
// SQL static instead of assembling an OR-chained WHERE per collection. Taking
// ListLimit per rule is exact rather than approximate: the newest N of a union is
// always contained in the union of the per-rule newest N.
func (s *Server) collectionArticles(c store.Collection, withSummary bool) ([]model.Article, error) {
	rdb := s.DB.Reader()
	arts := []model.Article{}
	// Rules may overlap (a feed rule and a global keyword rule can both select the
	// same article); without this the stream would show it twice.
	seen := map[string]bool{}
	for _, rule := range c.Rules {
		rule = rule.Normalized()
		if !rule.Valid() {
			continue
		}
		rows, err := store.RuleArticles(rdb, rule, articles.ListLimit)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			if seen[row.ArticleID] {
				continue
			}
			seen[row.ArticleID] = true
			arts = append(arts, articles.RowToArticle(row, withSummary, false))
		}
	}
	articles.ByPubDateDesc(arts)
	if len(arts) > articles.ListLimit {
		arts = arts[:articles.ListLimit]
	}
	return arts, nil
}
