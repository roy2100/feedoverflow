package httpapi

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	readability "codeberg.org/readeck/go-readability/v2"

	"rss-reader/server-go/internal/favicon"
	"rss-reader/server-go/internal/httpx"
	"rss-reader/server-go/internal/ssrf"
)

// fetchContentUA is the browser UA fetch-content sends, matching content.ts (many
// sites gate article HTML behind a real-browser User-Agent).
const fetchContentUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
	"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// fetchContentTimeout mirrors the 15s AbortSignal.timeout in content.ts.
const fetchContentTimeout = 15 * time.Second

// getFetchContent is the port of GET /api/fetch-content: SSRF-guard a
// client-supplied URL, fetch it with a browser UA, and extract readable content
// via go-readability. Output is NOT byte-identical to @mozilla/readability (and
// isn't persisted or contract-diffed), only usable readable HTML.
func (s *Server) getFetchContent(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	if raw == "" {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "url required"})
		return
	}
	// This endpoint fetches a client-supplied URL — block private/loopback/metadata
	// targets (SSRF defense-in-depth).
	if err := ssrf.AssertSafeURL(r.Context(), raw); err != nil {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{
			"error": "Blocked URL", "detail": err.Error(),
		})
		return
	}

	html, status, err := fetchArticleHTML(r.Context(), raw)
	if err != nil {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]any{
			"error": "Fetch failed", "detail": err.Error(),
		})
		return
	}
	if status < 200 || status >= 300 {
		httpx.WriteJSON(w, http.StatusBadGateway, map[string]any{
			"error": fmt.Sprintf("Upstream %d", status),
		})
		return
	}

	pageURL, _ := url.Parse(raw)
	art, err := readability.FromReader(bytes.NewReader(html), pageURL)
	if err != nil || art.Node == nil {
		httpx.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error": "Could not extract content",
		})
		return
	}
	var content bytes.Buffer
	if err := art.RenderHTML(&content); err != nil {
		httpx.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error": "Could not extract content",
		})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"content": content.String(),
		"title":   art.Title(),
		"byline":  art.Byline(),
	})
}

func fetchArticleHTML(ctx context.Context, raw string) ([]byte, int, error) {
	ctx, cancel := context.WithTimeout(ctx, fetchContentTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", fetchContentUA)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, res.StatusCode, nil
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, res.StatusCode, err
	}
	return body, res.StatusCode, nil
}

// getFaviconRoute is the port of GET /api/favicon: serve the cached favicon BLOB
// (long TTL), or a placeholder SVG (short TTL, still 200) when unavailable — so
// the browser never logs a failed request.
func (s *Server) getFaviconRoute(w http.ResponseWriter, r *http.Request) {
	domain := r.URL.Query().Get("domain")
	var result *favicon.Result
	if s.Favicon != nil {
		if res, err := s.Favicon.Get(r.Context(), domain); err == nil {
			result = res
		}
	}
	if result != nil {
		w.Header().Set("Cache-Control", "public, max-age=604800") // overrides /api no-store
		w.Header().Set("Content-Type", result.ContentType)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(result.Image)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("Content-Type", favicon.DefaultContentType)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(favicon.DefaultFavicon)
}
