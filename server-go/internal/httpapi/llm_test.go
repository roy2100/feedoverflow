package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
	"time"

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

// Enabling stamps the watermark ~24h back, not at now. Feed items routinely carry
// a pub_date hours older than the fetch, so a watermark pinned at now would let
// the next several polls land untranslated and read as the feature being broken.
func TestLLMConfigEnableStampsWatermark24hBack(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()

	before := time.Now().UnixMilli()
	if rec := do(h, "PATCH", "/api/llm/config", `{"enabled":true}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("PATCH: %d %s", rec.Code, rec.Body.String())
	}

	var enabled int
	var since sql.NullInt64
	if err := s.DB.Reader().QueryRow(`SELECT enabled, translate_since FROM llm_config WHERE id = 1`).
		Scan(&enabled, &since); err != nil {
		t.Fatal(err)
	}
	if enabled != 1 {
		t.Fatal("enabled not set")
	}
	if !since.Valid {
		t.Fatal("translate_since not stamped")
	}
	day := int64(24 * time.Hour / time.Millisecond)
	// A day back, give or take the second this test takes to run.
	if delta := before - since.Int64; delta < day-60_000 || delta > day+60_000 {
		t.Fatalf("translate_since is %dms back, want ~%dms", delta, day)
	}
}

// Re-enabling after a spell switched off must re-stamp: the articles published
// while it was off were deliberately not translated, and reaching back over them
// would undo that decision (and pay for it).
func TestLLMConfigReEnableRestampsWatermark(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()

	do(h, "PATCH", "/api/llm/config", `{"enabled":true}`, jsonHdr())
	var first int64
	_ = s.DB.Reader().QueryRow(`SELECT translate_since FROM llm_config WHERE id = 1`).Scan(&first)

	// Backdate it so a re-stamp is unambiguous.
	if _, err := s.DB.Writer().Exec(
		`UPDATE llm_config SET translate_since = ? WHERE id = 1`, first-1_000_000); err != nil {
		t.Fatal(err)
	}
	do(h, "PATCH", "/api/llm/config", `{"enabled":false}`, jsonHdr())
	do(h, "PATCH", "/api/llm/config", `{"enabled":true}`, jsonHdr())

	var second int64
	_ = s.DB.Reader().QueryRow(`SELECT translate_since FROM llm_config WHERE id = 1`).Scan(&second)
	if second <= first-1_000_000 {
		t.Fatalf("watermark not re-stamped on re-enable: %d", second)
	}
}

// Switching off leaves the watermark alone — it is only ever set on enable.
func TestLLMConfigDisableKeepsKeyAndWatermark(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	setKey(t, s, "sk-keep")
	do(h, "PATCH", "/api/llm/config", `{"enabled":true}`, jsonHdr())

	if rec := do(h, "PATCH", "/api/llm/config", `{"enabled":false}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("PATCH: %d %s", rec.Code, rec.Body.String())
	}
	var key string
	var since sql.NullInt64
	if err := s.DB.Reader().QueryRow(`SELECT api_key, translate_since FROM llm_config WHERE id = 1`).
		Scan(&key, &since); err != nil {
		t.Fatal(err)
	}
	if key != "sk-keep" {
		t.Fatalf("disabling cleared the key: %q", key)
	}
	if !since.Valid {
		t.Fatal("disabling cleared the watermark")
	}
	rec := do(h, "GET", "/api/llm/config", "", nil)
	if !strings.Contains(rec.Body.String(), `"enabled":false`) {
		t.Fatalf("GET does not report the switch: %s", rec.Body.String())
	}
}

// The settings form sends `enabled` with every save, so a save while the switch is
// already on must not move the watermark — that would silently skip everything
// published since it was turned on.
func TestLLMConfigSaveWhileEnabledKeepsWatermark(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()

	do(h, "PATCH", "/api/llm/config", `{"enabled":true}`, jsonHdr())
	var first int64
	if err := s.DB.Reader().QueryRow(`SELECT translate_since FROM llm_config WHERE id = 1`).
		Scan(&first); err != nil {
		t.Fatal(err)
	}

	// An ordinary edit that happens to carry enabled:true again.
	if rec := do(h, "PATCH", "/api/llm/config",
		`{"model":"kimi-k2","enabled":true}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("PATCH: %d %s", rec.Code, rec.Body.String())
	}
	var second int64
	if err := s.DB.Reader().QueryRow(`SELECT translate_since FROM llm_config WHERE id = 1`).
		Scan(&second); err != nil {
		t.Fatal(err)
	}
	if second != first {
		t.Fatalf("watermark moved on a no-op enable: %d -> %d", first, second)
	}
}
