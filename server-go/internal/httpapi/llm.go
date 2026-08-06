package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"rss-reader/server-go/internal/httpx"
	"rss-reader/server-go/internal/store"
	"rss-reader/server-go/internal/translate"
)

// getLLMConfig is GET /api/llm/config: the endpoint and model, plus whether a key
// is stored.
//
// The key itself is never returned — only key_set. This endpoint sits on the
// public router behind the session gate, and a session that can *set* a credential
// is a much smaller problem than one that can read it back out. It is also why the
// config lives in its own table rather than in `settings`, which GET /api/settings
// serializes wholesale.
func (s *Server) getLLMConfig(w http.ResponseWriter, _ *http.Request) {
	cfg, err := store.LLMConfig(s.DB.Reader())
	if err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"base_url": cfg.Conn.BaseURL,
		"model":    cfg.Conn.Model,
		"key_set":  cfg.Conn.APIKey != "",
		"enabled":  cfg.Enabled,
	})
}

// patchLLMConfig is PATCH /api/llm/config: update any subset of endpoint, model
// and key. Each field is an optional pointer, so editing the model does not
// require the browser to re-send (or ever have held) the API key.
func (s *Server) patchLLMConfig(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BaseURL *string `json:"base_url"`
		Model   *string `json:"model"`
		APIKey  *string `json:"api_key"`
		Enabled *bool   `json:"enabled"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.BaseURL == nil && body.Model == nil && body.APIKey == nil && body.Enabled == nil {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "no fields to update"})
		return
	}
	if body.BaseURL != nil {
		v := strings.TrimSpace(*body.BaseURL)
		// base_url arrives over HTTP, so it is restricted to https or a loopback host
		// (the latter for local runtimes like Ollama, which have no TLS and need none).
		if err := translate.ValidateBaseURL(v); err != nil {
			httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		body.BaseURL = &v
	}
	if body.Model != nil {
		v := strings.TrimSpace(*body.Model)
		if v == "" {
			httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "模型名称不能为空"})
			return
		}
		body.Model = &v
	}
	if body.APIKey != nil {
		// An empty key is meaningful: it is how translation is switched off.
		v := strings.TrimSpace(*body.APIKey)
		body.APIKey = &v
	}
	if err := store.SaveLLMConfig(
		s.DB.Writer(), body.BaseURL, body.APIKey, body.Model, body.Enabled); err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// postLLMConfigTest is POST /api/llm/config/test: translate one fixed string
// through the stored config.
//
// It deliberately runs a real translation rather than probing a health route: the
// failures that matter here (wrong model name, a key without chat permission, an
// endpoint that speaks a different protocol) all pass a health check and still
// leave every title untranslated. The reply carries only a normalized message —
// an upstream response body is never echoed back to the browser.
func (s *Server) postLLMConfigTest(w http.ResponseWriter, r *http.Request) {
	if s.Translator == nil {
		httpx.WriteJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "翻译服务未启用"})
		return
	}
	cfg, err := store.LLMConfig(s.DB.Reader())
	if err != nil {
		serverError(w, err)
		return
	}
	// Only the connection has to be usable — the test is about whether the endpoint
	// answers, not about whether translation is currently switched on.
	if !cfg.Conn.Ready() {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "请先填写 API Key"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.Translator.Check(ctx, cfg.Conn); err != nil {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}
