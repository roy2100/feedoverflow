package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"rss-reader/server-go/internal/translate"
)

// fakeChecker stands in for the real client so the test endpoint never dials out.
type fakeChecker struct{ err error }

func (f fakeChecker) Check(context.Context, translate.Config) error { return f.err }

func setKey(t *testing.T, s *Server, key string) {
	t.Helper()
	if _, err := s.DB.Writer().Exec(`UPDATE llm_config SET api_key = ? WHERE id = 1`, key); err != nil {
		t.Fatal(err)
	}
}

// The API key must never leave the server. This is the reason llm_config is its
// own table rather than a `settings` row — GET /api/settings serializes that table
// wholesale, so a key there would leak on any ordinary settings read.
func TestLLMConfigNeverReturnsKey(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	setKey(t, s, "sk-super-secret")

	rec := do(h, "GET", "/api/llm/config", "", nil)
	if rec.Code != 200 {
		t.Fatalf("GET: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "sk-super-secret") {
		t.Fatalf("api key leaked: %s", rec.Body.String())
	}
	var got struct {
		BaseURL string `json:"base_url"`
		Model   string `json:"model"`
		KeySet  bool   `json:"key_set"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.KeySet {
		t.Fatal("key_set = false with a key stored")
	}
	if got.BaseURL == "" || got.Model == "" {
		t.Fatalf("endpoint/model missing: %+v", got)
	}

	// And the settings endpoint, which does serialize its whole table, must not
	// have grown the key either.
	if rec := do(h, "GET", "/api/settings", "", nil); strings.Contains(rec.Body.String(), "sk-super-secret") {
		t.Fatalf("api key leaked through /api/settings: %s", rec.Body.String())
	}
}

// A partial PATCH must leave the stored key alone: that is what lets the settings
// panel change the model without the browser ever having held the secret.
func TestLLMConfigPatchPreservesKey(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	setKey(t, s, "sk-keep-me")

	if rec := do(h, "PATCH", "/api/llm/config", `{"model":"  kimi-k2  "}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("PATCH: %d %s", rec.Code, rec.Body.String())
	}
	var key, model string
	if err := s.DB.Reader().QueryRow(`SELECT api_key, model FROM llm_config WHERE id = 1`).
		Scan(&key, &model); err != nil {
		t.Fatal(err)
	}
	if key != "sk-keep-me" {
		t.Fatalf("key clobbered by a model-only patch: %q", key)
	}
	if model != "kimi-k2" {
		t.Fatalf("model = %q, want trimmed", model)
	}
}

// base_url now arrives over HTTP, so it is restricted to https or loopback.
func TestLLMConfigRejectsPlaintextRemoteBaseURL(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()

	if rec := do(h, "PATCH", "/api/llm/config", `{"base_url":"http://169.254.169.254"}`, jsonHdr()); rec.Code != 400 {
		t.Fatalf("plaintext remote base_url accepted: %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(h, "PATCH", "/api/llm/config", `{"base_url":"http://127.0.0.1:11434/v1"}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("loopback base_url rejected: %d %s", rec.Code, rec.Body.String())
	}
}

// Clearing the key is meaningful — it is how translation is switched off.
func TestLLMConfigCanClearKey(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	setKey(t, s, "sk-remove-me")

	if rec := do(h, "PATCH", "/api/llm/config", `{"api_key":""}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("PATCH: %d %s", rec.Code, rec.Body.String())
	}
	rec := do(h, "GET", "/api/llm/config", "", nil)
	if strings.Contains(rec.Body.String(), `"key_set":true`) {
		t.Fatalf("key_set still true after clearing: %s", rec.Body.String())
	}
}

// A failing test call reports the normalized reason, never the upstream body, and
// still answers 200 — the request succeeded, the configuration did not.
func TestLLMConfigTestReportsNormalizedError(t *testing.T) {
	s := &Server{DB: testDB(t), Translator: fakeChecker{err: translate.ErrAuth}}
	h := s.NewLocalRouter()
	setKey(t, s, "sk-bad")

	rec := do(h, "POST", "/api/llm/config/test", "", jsonHdr())
	if rec.Code != 200 {
		t.Fatalf("test: %d %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"ok":false`) || !strings.Contains(body, "认证失败") {
		t.Fatalf("unexpected body: %s", body)
	}
}

// Without a key there is nothing to test, and the endpoint must say so rather
// than dialing out with an empty bearer token.
func TestLLMConfigTestWithoutKey(t *testing.T) {
	s := &Server{DB: testDB(t), Translator: fakeChecker{}}
	h := s.NewLocalRouter()

	rec := do(h, "POST", "/api/llm/config/test", "", jsonHdr())
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"ok":false`) {
		t.Fatalf("unexpected: %d %s", rec.Code, rec.Body.String())
	}
}
