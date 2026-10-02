package httpapi

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"rss-reader/server-go/internal/feed"
)

// seedSummaryRow inserts one article carrying both a summary and content, dated
// now so it lands in /api/today as well as /api/all-articles.
func seedSummaryRow(t *testing.T, s *Server, id, feedID string) {
	t.Helper()
	now := time.Now()
	_, err := s.DB.Writer().Exec(
		`INSERT INTO article_states
		   (article_id, feed_id, feed_name, title, link, pub_date, pub_ts, summary, content, is_starred)
		 VALUES (?, ?, 'F', 'T', ?, ?, ?, 'the summary', 'the content', 0)`,
		id, feedID, "https://x/"+id, now.Format(time.RFC1123), now.UnixMilli())
	if err != nil {
		t.Fatalf("seed %s: %v", id, err)
	}
}

// listFields pulls the summary/content of the first article in a list response.
func listFields(t *testing.T, body string) (summary, content string) {
	t.Helper()
	var res struct {
		Articles []struct {
			Summary string `json:"summary"`
			Content string `json:"content"`
		} `json:"articles"`
	}
	if err := json.Unmarshal([]byte(body), &res); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	if len(res.Articles) != 1 {
		t.Fatalf("want 1 article, got %d: %s", len(res.Articles), body)
	}
	return res.Articles[0].Summary, res.Articles[0].Content
}

// The list endpoints strip summary+content by default (the browser's list panes
// render neither); ?summary=1 — what the MCP list tools send — brings back the
// summary alone, never the full content.
func TestListArticlesSummaryParam(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	seedSummaryRow(t, s, "a1", "1") // feed "1" is one of the schema's default feeds

	// Both modes: digest takes a different code path (per-feed fan-out) from latest.
	for _, tc := range []struct{ bare, withSummary string }{
		{"/api/all-articles", "/api/all-articles?summary=1"},
		{"/api/all-articles?mode=digest", "/api/all-articles?mode=digest&summary=1"},
		{"/api/today", "/api/today?summary=1"},
		{"/api/today?mode=digest", "/api/today?mode=digest&summary=1"},
	} {
		summary, content := listFields(t, do(h, "GET", tc.bare, "", nil).Body.String())
		if summary != "" || content != "" {
			t.Errorf("%s: want summary+content stripped, got %q / %q", tc.bare, summary, content)
		}

		summary, content = listFields(t, do(h, "GET", tc.withSummary, "", nil).Body.String())
		if summary != "the summary" {
			t.Errorf("%s: want summary, got %q", tc.withSummary, summary)
		}
		if content != "" {
			t.Errorf("%s: want content still stripped, got %q", tc.withSummary, content)
		}
	}
}

func TestFeedArticlesSummaryParam(t *testing.T) {
	items := []feed.Item{
		{Link: "https://x/1", Title: "One", Summary: "the summary", Content: "the content",
			PubDate: "Fri, 01 Aug 2025 00:30:00 GMT"},
	}
	s := newFeedsServer(t, fakeParse("Fresh Feed", items...))
	h := s.NewLocalRouter()

	rec := do(h, "POST", "/api/feeds", `{"url":"https://fresh.example/rss"}`, jsonHdr())
	var added struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &added)

	summary, content := listFields(t, do(h, "GET", "/api/feeds/"+added.ID+"/articles", "", nil).Body.String())
	if summary != "" || content != "" {
		t.Errorf("default: want summary+content stripped, got %q / %q", summary, content)
	}

	summary, content = listFields(t,
		do(h, "GET", "/api/feeds/"+added.ID+"/articles?summary=1", "", nil).Body.String())
	if summary != "the summary" {
		t.Errorf("summary=1: want summary, got %q", summary)
	}
	if content != "" {
		t.Errorf("summary=1: want content still stripped, got %q", content)
	}

	summary, _ = listFields(t,
		do(h, "GET", "/api/feeds/"+added.ID+"/articles?summary=short", "", nil).Body.String())
	if summary != "the summary" {
		t.Errorf("summary=short: want the summary, got %q", summary)
	}
}

// The mirror of the stripping above: the two reads that *do* carry content must
// keep carrying it. List queries deliberately never name the `content` column —
// an article body lives in SQLite overflow pages, so selecting it costs page reads
// even when the value is thrown away — and this pins the two exceptions, so
// switching them to the light column set fails here instead of silently emptying
// the reader pane and the push deep link.
func TestContentCarryingReads(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	seedSummaryRow(t, s, "k1", "f1")
	if _, err := s.DB.Writer().Exec(
		`UPDATE article_states SET is_starred = 1, starred_at = 1 WHERE article_id = 'k1'`,
	); err != nil {
		t.Fatalf("star: %v", err)
	}

	if _, content := listFields(t, do(h, "GET", "/api/starred", "", nil).Body.String()); content != "the content" {
		t.Errorf("/api/starred: want content, got %q", content)
	}

	rec := do(h, "GET", "/api/articles/k1", "", nil)
	var one struct {
		Article struct {
			Content string `json:"content"`
		} `json:"article"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &one); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if one.Article.Content != "the content" {
		t.Errorf("/api/articles/:id: want content, got %q", one.Article.Content)
	}
}

// `?summary=short` is the mobile card deck's: a summary that fits passes through
// untouched, a long one is cut to cardSummaryLen and marked with an ellipsis, and
// content stays stripped either way. The feed endpoint needs a cache to ensure
// freshness, so its `short` case lives in TestFeedArticlesSummaryParam.
func TestListArticlesShortSummary(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	now := time.Now()
	long := strings.Repeat("长", cardSummaryLen+50)
	if _, err := s.DB.Writer().Exec(
		`INSERT INTO article_states
		   (article_id, feed_id, feed_name, title, link, pub_date, pub_ts, summary, content,
		    audio_url, is_starred)
		 VALUES ('p1', '1', 'F', 'T', 'https://x/p1', ?, ?, ?, 'the content', 'https://x/a.mp3', 0)`,
		now.Format(time.RFC1123), now.UnixMilli(), long); err != nil {
		t.Fatalf("seed: %v", err)
	}

	for _, path := range []string{
		"/api/all-articles?summary=short",
		"/api/today?mode=digest&summary=short",
		"/api/podcasts?summary=short",
	} {
		summary, content := listFields(t, do(h, "GET", path, "", nil).Body.String())
		if want := strings.Repeat("长", cardSummaryLen) + "…"; summary != want {
			t.Errorf("%s: want %d runes + ellipsis, got %d runes", path, cardSummaryLen,
				len([]rune(summary)))
		}
		if content != "" {
			t.Errorf("%s: want content stripped, got %q", path, content)
		}
	}

	// Podcasts stays title-only without the param, like every other list.
	if summary, _ := listFields(t, do(h, "GET", "/api/podcasts", "", nil).Body.String()); summary != "" {
		t.Errorf("/api/podcasts: want summary stripped by default, got %d runes", len([]rune(summary)))
	}

	if _, err := s.DB.Writer().Exec(`UPDATE article_states SET summary = 'short one'`); err != nil {
		t.Fatalf("update: %v", err)
	}
	if summary, _ := listFields(t, do(h, "GET", "/api/all-articles?summary=short", "", nil).Body.String()); summary != "short one" {
		t.Errorf("a summary that fits must pass through untouched, got %q", summary)
	}
}
