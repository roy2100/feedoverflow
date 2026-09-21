package translate

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// echoServer answers every request with reply(user message) and records what it
// was sent, so a test can check both the wire shape and the per-piece sequence.
func echoServer(t *testing.T, reply func(user string) string) (Config, *[]chatRequest) {
	t.Helper()
	var mu sync.Mutex
	var got []chatRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		mu.Lock()
		got = append(got, req)
		mu.Unlock()
		user := req.Messages[len(req.Messages)-1].Content
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"content": reply(user)}}},
		})
	}))
	t.Cleanup(srv.Close)
	return Config{BaseURL: srv.URL, APIKey: "sk-test", Model: "m"}, &got
}

func TestSplitBodyPacksParagraphsAndSplitsLongOnes(t *testing.T) {
	short := "Short one."
	long := strings.Repeat("This is a sentence that goes on. ", 20) // ~660 runes
	text := short + "\n\n" + short + "\n\n" + long + "\n\n" + short

	got := SplitBody(text, 300)
	for i, p := range got {
		if n := len([]rune(p)); n > 300 {
			t.Fatalf("piece %d is %d runes, over the cap: %q", i, n, p)
		}
		if strings.TrimSpace(p) == "" {
			t.Fatalf("piece %d is blank", i)
		}
	}
	// The two leading shorts pack into one piece; the long paragraph is cut at
	// sentence ends (never mid-word); the trailing short stands alone or packs onto
	// the last long piece — either way every sentence survives exactly once.
	if !strings.HasPrefix(got[0], short+"\n\n"+short) {
		t.Fatalf("shorts not packed: %q", got[0])
	}
	joined := strings.Join(got, " ")
	if strings.Count(joined, "goes on.") != 20 || strings.Count(joined, short) != 3 {
		t.Fatalf("content lost or duplicated in split:\n%s", joined)
	}
	for _, p := range got {
		if strings.Contains(p, "sentence that goes on. This") && !strings.HasSuffix(p, ".") {
			t.Fatalf("piece ends mid-sentence: %q", p)
		}
	}
}

func TestSplitBodyKeepsDecimalsAndHardCutsMonsterSentence(t *testing.T) {
	// "3.5" must not be a sentence end; a single 50-rune "sentence" with a 20 cap
	// is hard-cut rather than dropped or looped on.
	got := SplitBody("Version 3.5 shipped. "+strings.Repeat("x", 50), 20)
	all := strings.Join(got, "")
	if !strings.Contains(all, "3.5") || strings.Count(all, "x") != 50 {
		t.Fatalf("split mangled content: %q", got)
	}
	for _, p := range got {
		if len([]rune(p)) > 20 {
			t.Fatalf("over cap: %q", p)
		}
	}
	if len(SplitBody("   \n\n  \n", 100)) != 0 {
		t.Fatal("blank body should yield no pieces")
	}
}

func TestTranslateBodyOnePieceOneRequestInOrder(t *testing.T) {
	cfg, got := echoServer(t, func(user string) string { return "译:" + user })
	c := New(nil)
	// Three paragraphs, each just under the cap, so each becomes its own piece.
	p := strings.Repeat("English words here. ", pieceRunes/20)
	text := p + "\n\n" + p + "\n\n" + p

	var pieces []string
	err := c.TranslateBody(context.Background(), cfg, text, func(s string) error {
		pieces = append(pieces, s)
		return nil
	})
	if err != nil {
		t.Fatalf("TranslateBody: %v", err)
	}
	if len(pieces) != 3 || len(*got) != 3 {
		t.Fatalf("pieces=%d requests=%d, want 3/3", len(pieces), len(*got))
	}
	for i, req := range *got {
		if req.Messages[0].Role != "system" || req.Messages[0].Content != translatePrompt {
			t.Fatalf("request %d: system prompt missing or not byte-identical", i)
		}
		if len(req.Messages) != 2 {
			t.Fatalf("request %d: %d messages, want system + user only", i, len(req.Messages))
		}
		if req.Thinking == nil || req.MaxTokens != translationMaxTokens {
			t.Fatalf("request %d: thinking/max_tokens not set: %+v", i, req)
		}
		if !strings.HasPrefix(pieces[i], "译:"+req.Messages[1].Content[:20]) {
			t.Fatalf("piece %d does not correspond to request %d", i, i)
		}
	}
}

func TestTranslateBodySkipsChineseAndLetterlessPieces(t *testing.T) {
	calls := 0
	cfg, _ := echoServer(t, func(user string) string { calls++; return "译文" })
	text := "An English paragraph to translate.\n\n这一段已经是中文了。\n\n12:30 — 45%"
	var pieces []string
	err := New(nil).TranslateBody(context.Background(), cfg, text, func(s string) error {
		pieces = append(pieces, s)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// The three short paragraphs pack into one piece, which is mostly non-Han
	// letters → one request. The whole-body Chinese check is what matters here:
	if calls != 1 {
		t.Fatalf("calls = %d, want 1", calls)
	}
	// A body that is mostly Chinese is refused before any request.
	calls = 0
	err = New(nil).TranslateBody(context.Background(), cfg, "这是一篇中文文章。\n\n第二段。", func(string) error { return nil })
	if !errors.Is(err, ErrAlreadyChinese) || calls != 0 {
		t.Fatalf("chinese body: err=%v calls=%d", err, calls)
	}
}

func TestTranslateBodyStopsWhenEmitFails(t *testing.T) {
	cfg, got := echoServer(t, func(string) string { return "译文" })
	p := strings.Repeat("English words here. ", pieceRunes/20)
	gone := errors.New("client went away")
	err := New(nil).TranslateBody(context.Background(), cfg, p+"\n\n"+p+"\n\n"+p, func(string) error {
		return gone
	})
	if !errors.Is(err, gone) {
		t.Fatalf("err = %v, want emit's error", err)
	}
	if len(*got) != 1 {
		t.Fatalf("kept requesting after emit failed: %d requests", len(*got))
	}
}

func TestTranslateBodyRejectsRunawayAndEmptyAnswers(t *testing.T) {
	cfg, _ := echoServer(t, func(user string) string { return strings.Repeat("解释", 5*len([]rune(user))) })
	err := New(nil).TranslateBody(context.Background(), cfg, "Short English text.", func(string) error { return nil })
	if !errors.Is(err, ErrEmpty) {
		t.Fatalf("runaway answer: err = %v, want ErrEmpty", err)
	}
	cfg, _ = echoServer(t, func(string) string { return "  \n " })
	err = New(nil).TranslateBody(context.Background(), cfg, "Short English text.", func(string) error { return nil })
	if !errors.Is(err, ErrEmpty) {
		t.Fatalf("blank answer: err = %v, want ErrEmpty", err)
	}
}

func TestSummarizeUsesItsOwnPromptAndCleansTheAnswer(t *testing.T) {
	cfg, got := echoServer(t, func(string) string {
		return "<think>let me think</think>\n摘要：这篇文章讲了 X。\n- 要点一\n- 要点二"
	})
	out, err := New(nil).Summarize(context.Background(), cfg, "Some long English article body.")
	if err != nil {
		t.Fatal(err)
	}
	if out != "这篇文章讲了 X。\n- 要点一\n- 要点二" {
		t.Fatalf("cleaned summary = %q", out)
	}
	req := (*got)[0]
	if req.Messages[0].Content != summaryPrompt || req.Messages[1].Content != "Some long English article body." {
		t.Fatalf("wire: %+v", req.Messages)
	}
	if req.MaxTokens != summaryMaxTokens {
		t.Fatalf("max_tokens = %d", req.MaxTokens)
	}
}

func TestSummarizeTruncatesInputAndRejectsEmpty(t *testing.T) {
	cfg, got := echoServer(t, func(string) string { return "" })
	long := strings.Repeat("word ", maxSummaryInputRunes) // 5× the cap
	_, err := New(nil).Summarize(context.Background(), cfg, long)
	if !errors.Is(err, ErrEmpty) {
		t.Fatalf("empty answer: err = %v", err)
	}
	if n := len([]rune((*got)[0].Messages[1].Content)); n > maxSummaryInputRunes {
		t.Fatalf("sent %d runes, cap is %d", n, maxSummaryInputRunes)
	}
	if _, err := New(nil).Summarize(context.Background(), cfg, "  \n\n "); !errors.Is(err, ErrEmpty) {
		t.Fatalf("blank input: err = %v", err)
	}
}

// The 400 retry from the title path applies here too: a provider that rejects
// the thinking field is asked again without it rather than reported as down.
func TestBodyRequestRetriesWithoutThinkingOn400(t *testing.T) {
	var reqs []chatRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		reqs = append(reqs, req)
		w.Header().Set("Content-Type", "application/json")
		if req.Thinking != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"摘要"}}]}`))
	}))
	defer srv.Close()
	cfg := Config{BaseURL: srv.URL, APIKey: "k", Model: "m"}
	out, err := New(nil).Summarize(context.Background(), cfg, "English text.")
	if err != nil || out != "摘要" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	if len(reqs) != 2 || reqs[1].Thinking != nil || reqs[1].MaxTokens != 0 {
		t.Fatalf("retry shape: %+v", reqs)
	}
}

func TestCleanBodyStripsFirstLineLabelOnly(t *testing.T) {
	in := "译文：第一段\n\n摘要：这不是标签，是正文"
	if got := cleanBody(in); got != "第一段\n\n摘要：这不是标签，是正文" {
		t.Fatalf("cleanBody = %q", got)
	}
	if got := cleanBody("「整段被引号包住」"); got != "整段被引号包住" {
		t.Fatalf("unwrap = %q", got)
	}
	if got := cleanBody("「开头引用」然后继续"); got != "「开头引用」然后继续" {
		t.Fatalf("partial quote must stay: %q", got)
	}
}
