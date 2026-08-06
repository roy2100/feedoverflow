package translate

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIsMostlyChinese(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"Apple unveils M5 chip, 40% faster", false},
		{"苹果发布 M5 芯片，性能提升 40%", true},
		// A Chinese headline routinely carries a Latin product name; the 30% ratio
		// exists so those still count as Chinese.
		{"OpenAI 发布新模型", true},
		// The reverse: an English headline with one Chinese term must still be sent.
		{"Xiaomi ships the 小米 15 to Europe this quarter", false},
		// No letters at all — nothing a translation would change.
		{"2026 :: 40% !!", true},
		{"", true},
	}
	for _, c := range cases {
		if got := IsMostlyChinese(c.in); got != c.want {
			t.Errorf("IsMostlyChinese(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestCleanStripsWrappers(t *testing.T) {
	in := "Apple unveils M5 chip"
	cases := []struct{ raw, want string }{
		{`苹果发布 M5 芯片`, "苹果发布 M5 芯片"},
		{`"苹果发布 M5 芯片"`, "苹果发布 M5 芯片"},
		{"  “苹果发布 M5 芯片”  ", "苹果发布 M5 芯片"},
		{"「苹果发布 M5 芯片」", "苹果发布 M5 芯片"},
		{"", ""},
	}
	for _, c := range cases {
		if got := clean(c.raw, in); got != c.want {
			t.Errorf("clean(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
}

// A model that explains itself instead of translating must not have its essay
// stored as a headline. Returning "" settles the row without retrying.
func TestCleanRejectsRunawayAnswer(t *testing.T) {
	in := "Apple unveils M5 chip"
	essay := strings.Repeat("这句话是对该标题的详细解释。", 40)
	if got := clean(essay, in); got != "" {
		t.Fatalf("runaway answer was accepted (%d runes)", len([]rune(got)))
	}
}

func TestCleanTruncates(t *testing.T) {
	in := strings.Repeat("a", maxTitleRunes)
	out := clean(strings.Repeat("好", maxTitleRunes+50), in)
	if n := len([]rune(out)); n != maxTitleRunes {
		t.Fatalf("len = %d, want %d", n, maxTitleRunes)
	}
}

func TestValidateBaseURL(t *testing.T) {
	ok := []string{
		"https://api.deepseek.com",
		"https://api.moonshot.cn/v1",
		"http://127.0.0.1:11434/v1",
		"http://localhost:8000/v1",
	}
	for _, u := range ok {
		if err := ValidateBaseURL(u); err != nil {
			t.Errorf("ValidateBaseURL(%q) = %v, want nil", u, err)
		}
	}
	bad := []string{
		"http://example.com",     // plaintext to a remote host
		"http://169.254.169.254", // cloud metadata over plaintext
		"ftp://api.deepseek.com",
		"not a url",
		"",
	}
	for _, u := range bad {
		if err := ValidateBaseURL(u); err == nil {
			t.Errorf("ValidateBaseURL(%q) = nil, want an error", u)
		}
	}
}

func TestEndpointJoin(t *testing.T) {
	cases := map[string]string{
		"https://api.deepseek.com":   "https://api.deepseek.com/chat/completions",
		"https://api.moonshot.cn/v1": "https://api.moonshot.cn/v1/chat/completions",
		"http://127.0.0.1:11434/v1/": "http://127.0.0.1:11434/v1/chat/completions",
	}
	for in, want := range cases {
		if got := endpoint(in); got != want {
			t.Errorf("endpoint(%q) = %q, want %q", in, got, want)
		}
	}
}

// serve stands up a fake OpenAI-compatible endpoint.
func serve(t *testing.T, status int, body string) Config {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return Config{BaseURL: srv.URL, APIKey: "sk-test", Model: "m"}
}

func TestTranslateReadsChoice(t *testing.T) {
	cfg := serve(t, http.StatusOK,
		`{"choices":[{"message":{"role":"assistant","content":"苹果发布 M5 芯片"}}]}`)
	got, err := New(nil).Translate(context.Background(), cfg, "Apple unveils M5 chip")
	if err != nil {
		t.Fatalf("Translate: %v", err)
	}
	if got != "苹果发布 M5 芯片" {
		t.Fatalf("got %q", got)
	}
}

// No choices is "the endpoint answered but gave nothing usable": empty string,
// nil error, so the caller settles the row instead of retrying forever.
func TestTranslateEmptyChoicesIsNotAnError(t *testing.T) {
	cfg := serve(t, http.StatusOK, `{"choices":[]}`)
	got, err := New(nil).Translate(context.Background(), cfg, "Apple unveils M5 chip")
	if err != nil || got != "" {
		t.Fatalf("got (%q, %v), want (\"\", nil)", got, err)
	}
}

// Status mapping exists so the settings panel can say something specific while
// the upstream body never reaches the browser.
func TestTranslateNormalizesStatuses(t *testing.T) {
	cases := []struct {
		status int
		want   error
	}{
		{http.StatusUnauthorized, ErrAuth},
		{http.StatusForbidden, ErrAuth},
		{http.StatusNotFound, ErrModel},
		{http.StatusBadRequest, ErrModel},
		{http.StatusInternalServerError, ErrUpstream},
	}
	for _, c := range cases {
		cfg := serve(t, c.status, `{"error":{"message":"secret upstream detail"}}`)
		_, err := New(nil).Translate(context.Background(), cfg, "Apple unveils M5 chip")
		if !errors.Is(err, c.want) {
			t.Errorf("status %d → %v, want %v", c.status, err, c.want)
		}
		if err != nil && strings.Contains(err.Error(), "secret upstream detail") {
			t.Errorf("status %d leaked the upstream body: %v", c.status, err)
		}
	}
}

func TestConfigReady(t *testing.T) {
	full := Config{BaseURL: "https://x", APIKey: "k", Model: "m"}
	if !full.Ready() {
		t.Fatal("full config not ready")
	}
	// An empty key is how the feature is switched off.
	noKey := full
	noKey.APIKey = ""
	if noKey.Ready() {
		t.Fatal("config with no key reported ready")
	}
}

// Thinking is off by default on DeepSeek at `high` effort, which measured ~1800
// characters of reasoning to produce a ~20-character headline — 95% of the
// completion tokens. The switch has to be on the wire, and max_tokens rides with
// it (only safe once thinking is off).
func TestTranslateDisablesThinking(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"苹果发布 M5 芯片"}}]}`))
	}))
	defer srv.Close()
	cfg := Config{BaseURL: srv.URL, APIKey: "sk-test", Model: "m"}

	if _, err := New(nil).Translate(context.Background(), cfg, "Apple unveils M5 chip"); err != nil {
		t.Fatalf("Translate: %v", err)
	}
	thinking, ok := got["thinking"].(map[string]any)
	if !ok || thinking["type"] != "disabled" {
		t.Fatalf(`thinking = %v, want {"type":"disabled"}`, got["thinking"])
	}
	if got["max_tokens"] != float64(maxCompletionTokens) {
		t.Fatalf("max_tokens = %v, want %d", got["max_tokens"], maxCompletionTokens)
	}
}

// `thinking` is DeepSeek's field. A provider that rejects unknown fields answers
// 400, and the only honest reading is "one of these is not understood" — so the
// call retries without them instead of reporting the model as unavailable.
// max_tokens must come off too: with thinking back on, a low cap truncates the
// model mid-thought and returns empty content, which the caller would settle as
// "no translation, never retry".
func TestTranslateRetriesWithoutThinkingOn400(t *testing.T) {
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		bodies = append(bodies, b)
		w.Header().Set("Content-Type", "application/json")
		if _, sent := b["thinking"]; sent {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"unknown field: thinking"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"苹果发布 M5 芯片"}}]}`))
	}))
	defer srv.Close()
	cfg := Config{BaseURL: srv.URL, APIKey: "sk-test", Model: "m"}

	got, err := New(nil).Translate(context.Background(), cfg, "Apple unveils M5 chip")
	if err != nil {
		t.Fatalf("Translate: %v", err)
	}
	if got != "苹果发布 M5 芯片" {
		t.Fatalf("got %q", got)
	}
	if len(bodies) != 2 {
		t.Fatalf("want 2 attempts, got %d", len(bodies))
	}
	if _, sent := bodies[1]["thinking"]; sent {
		t.Fatal("retry still carried the thinking field")
	}
	if _, sent := bodies[1]["max_tokens"]; sent {
		t.Fatal("retry still carried max_tokens; it would truncate the reasoning")
	}
}

// A 400 that is not about the request fields still ends as ErrModel after the
// retry, rather than looping.
func TestTranslateGivesUpWhenRetryAlso400s(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()
	cfg := Config{BaseURL: srv.URL, APIKey: "sk-test", Model: "nope"}

	_, err := New(nil).Translate(context.Background(), cfg, "Apple unveils M5 chip")
	if !errors.Is(err, ErrModel) {
		t.Fatalf("err = %v, want ErrModel", err)
	}
	if calls != 2 {
		t.Fatalf("want exactly 2 attempts, got %d", calls)
	}
}
