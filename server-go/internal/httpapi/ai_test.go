package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"rss-reader/server-go/internal/store"
	"rss-reader/server-go/internal/translate"
)

// fakeBodyAI records what it was asked and answers from canned pieces.
type fakeBodyAI struct {
	summary   string
	pieces    []string
	failAfter int // translation: return err after this many pieces (0 = never)
	err       error
	calls     int
	lastText  string
}

func (f *fakeBodyAI) Summarize(_ context.Context, _ translate.Config, text string) (string, error) {
	f.calls++
	f.lastText = text
	if f.err != nil {
		return "", f.err
	}
	return f.summary, nil
}

func (f *fakeBodyAI) TranslateBody(
	_ context.Context, _ translate.Config, text string, emit func(string) error,
) error {
	f.calls++
	f.lastText = text
	for i, p := range f.pieces {
		if f.failAfter > 0 && i == f.failAfter {
			return f.err
		}
		if err := emit(p); err != nil {
			return err
		}
	}
	return nil
}

func aiServer(t *testing.T, worker translate.BodyWorker) *Server {
	t.Helper()
	s := &Server{DB: testDB(t), BodyAI: worker}
	if _, err := s.DB.Writer().Exec(
		`UPDATE llm_config SET base_url = 'https://llm.example/v1', api_key = 'k', model = 'm' WHERE id = 1`,
	); err != nil {
		t.Fatal(err)
	}
	seedArticle(t, s, "a1", "<p>body</p>")
	return s
}

// events parses an SSE body into its frames.
func events(t *testing.T, body string) []aiEvent {
	t.Helper()
	var out []aiEvent
	for _, line := range strings.Split(body, "\n") {
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var ev aiEvent
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev); err != nil {
			t.Fatalf("bad frame %q: %v", line, err)
		}
		out = append(out, ev)
	}
	return out
}

func TestArticleAITranslationStreamsPiecesAndStores(t *testing.T) {
	f := &fakeBodyAI{pieces: []string{"第一段", "第二段"}}
	s := aiServer(t, f)
	h := s.NewLocalRouter()

	rec := do(h, "POST", "/api/articles/a1/ai", `{"kind":"translation","text":"First.\n\nSecond."}`, jsonHdr())
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type %q", ct)
	}
	ev := events(t, rec.Body.String())
	if len(ev) != 3 || ev[0].Piece != "第一段" || ev[1].Piece != "第二段" || !ev[2].Done || ev[2].Cached {
		t.Fatalf("events: %+v", ev)
	}
	if ev[2].Model != "m" {
		t.Fatalf("done frame should name the model: %+v", ev[2])
	}
	if f.lastText != "First.\n\nSecond." {
		t.Fatalf("worker got %q", f.lastText)
	}
	row, err := store.GetArticleAI(s.DB.Reader(), "a1", "translation")
	if err != nil || row == nil {
		t.Fatalf("not stored: %+v %v", row, err)
	}
	if row.Content != "第一段\n\n第二段" || row.Model != "m" {
		t.Fatalf("stored row: %+v", row)
	}
}

func TestArticleAISummaryCachedByTextHash(t *testing.T) {
	f := &fakeBodyAI{summary: "一句话概括"}
	s := aiServer(t, f)
	h := s.NewLocalRouter()

	first := events(t, do(h, "POST", "/api/articles/a1/ai", `{"kind":"summary","text":"Body text"}`, jsonHdr()).Body.String())
	if len(first) != 2 || first[0].Piece != "一句话概括" || first[1].Cached {
		t.Fatalf("first: %+v", first)
	}
	// Same text → replayed, no second call to the model.
	second := events(t, do(h, "POST", "/api/articles/a1/ai", `{"kind":"summary","text":"Body text"}`, jsonHdr()).Body.String())
	if f.calls != 1 {
		t.Fatalf("model called %d times for the same text", f.calls)
	}
	if len(second) != 2 || second[0].Piece != "一句话概括" || !second[1].Done || !second[1].Cached {
		t.Fatalf("second: %+v", second)
	}
	// Different text (the user loaded 全文) → regenerated, row replaced.
	f.summary = "全文的概括"
	third := events(t, do(h, "POST", "/api/articles/a1/ai", `{"kind":"summary","text":"Much longer full text"}`, jsonHdr()).Body.String())
	if f.calls != 2 || third[0].Piece != "全文的概括" || third[1].Cached {
		t.Fatalf("third: calls=%d %+v", f.calls, third)
	}
	row, _ := store.GetArticleAI(s.DB.Reader(), "a1", "summary")
	if row.Content != "全文的概括" {
		t.Fatalf("row not replaced: %+v", row)
	}
	// Kinds cache independently: a translation request still reaches the model.
	f.pieces = []string{"译"}
	_ = do(h, "POST", "/api/articles/a1/ai", `{"kind":"translation","text":"Body text"}`, jsonHdr())
	if f.calls != 3 {
		t.Fatalf("translation should not hit the summary cache: calls=%d", f.calls)
	}
}

func TestArticleAIFailureMidStreamStoresNothing(t *testing.T) {
	f := &fakeBodyAI{pieces: []string{"第一段", "第二段"}, failAfter: 1, err: translate.ErrUpstream}
	s := aiServer(t, f)
	h := s.NewLocalRouter()

	ev := events(t, do(h, "POST", "/api/articles/a1/ai", `{"kind":"translation","text":"One.\n\nTwo."}`, jsonHdr()).Body.String())
	if len(ev) != 2 || ev[0].Piece != "第一段" || ev[1].Error != translate.ErrUpstream.Error() {
		t.Fatalf("events: %+v", ev)
	}
	if row, _ := store.GetArticleAI(s.DB.Reader(), "a1", "translation"); row != nil {
		t.Fatalf("partial run was stored: %+v", row)
	}
}

// Upstream detail must not reach the browser: a connect error carries the
// endpoint host, and that is reduced to the normalized message.
func TestArticleAIErrorsAreNormalized(t *testing.T) {
	wrapped := errors.Join(translate.ErrConnect, errors.New("dial tcp 10.0.0.9:11434: refused"))
	f := &fakeBodyAI{err: wrapped}
	s := aiServer(t, f)
	h := s.NewLocalRouter()
	ev := events(t, do(h, "POST", "/api/articles/a1/ai", `{"kind":"summary","text":"x"}`, jsonHdr()).Body.String())
	if len(ev) != 1 || ev[0].Error != translate.ErrConnect.Error() {
		t.Fatalf("events: %+v", ev)
	}
	if strings.Contains(ev[0].Error, "10.0.0.9") {
		t.Fatalf("leaked upstream detail: %q", ev[0].Error)
	}
	f.err = errors.New("something internal: /Users/x/secret")
	ev = events(t, do(h, "POST", "/api/articles/a1/ai", `{"kind":"summary","text":"y"}`, jsonHdr()).Body.String())
	if ev[0].Error != "生成失败" {
		t.Fatalf("unknown error should be generic: %q", ev[0].Error)
	}
}

func TestArticleAIRejectsBadRequests(t *testing.T) {
	f := &fakeBodyAI{summary: "s"}
	s := aiServer(t, f)
	h := s.NewLocalRouter()

	if rec := do(h, "POST", "/api/articles/a1/ai", `{"kind":"poem","text":"x"}`, jsonHdr()); rec.Code != 400 {
		t.Fatalf("bad kind: %d", rec.Code)
	}
	if rec := do(h, "POST", "/api/articles/a1/ai", `{"kind":"summary","text":"   "}`, jsonHdr()); rec.Code != 400 {
		t.Fatalf("blank text: %d", rec.Code)
	}
	if rec := do(h, "POST", "/api/articles/nope/ai", `{"kind":"summary","text":"x"}`, jsonHdr()); rec.Code != 404 {
		t.Fatalf("missing article: %d", rec.Code)
	}
	if f.calls != 0 {
		t.Fatalf("model reached on a rejected request: %d calls", f.calls)
	}

	// No endpoint configured → 503 with a hint, before any stream starts.
	if _, err := s.DB.Writer().Exec(`UPDATE llm_config SET api_key = '' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	rec := do(h, "POST", "/api/articles/a1/ai", `{"kind":"summary","text":"x"}`, jsonHdr())
	if rec.Code != 503 || !strings.Contains(rec.Body.String(), "设置") {
		t.Fatalf("unconfigured: %d %s", rec.Code, rec.Body.String())
	}

	// No worker at all → 503.
	s2 := &Server{DB: testDB(t)}
	seedArticle(t, s2, "a1", "b")
	if rec := do(s2.NewLocalRouter(), "POST", "/api/articles/a1/ai", `{"kind":"summary","text":"x"}`, jsonHdr()); rec.Code != 503 {
		t.Fatalf("no worker: %d", rec.Code)
	}
}

// The title switch is the worker's intent, not this endpoint's: with `enabled`
// off but an endpoint configured, an explicit click still works.
func TestArticleAIIgnoresTitleSwitch(t *testing.T) {
	f := &fakeBodyAI{summary: "s"}
	s := aiServer(t, f)
	if _, err := s.DB.Writer().Exec(`UPDATE llm_config SET enabled = 0 WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	rec := do(s.NewLocalRouter(), "POST", "/api/articles/a1/ai", `{"kind":"summary","text":"x"}`, jsonHdr())
	if rec.Code != 200 || f.calls != 1 {
		t.Fatalf("status %d calls %d", rec.Code, f.calls)
	}
}
