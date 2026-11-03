package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"rss-reader/server-go/internal/dates"
)

func seedSearchRow(t *testing.T, s *Server, id, feedID, title, content string, starred int) {
	t.Helper()
	_, err := s.DB.Writer().Exec(
		`INSERT INTO article_states (article_id, feed_id, feed_name, title, link, pub_date, summary, content, is_starred)
		 VALUES (?, ?, 'F', ?, ?, 'Fri, 05 Jun 2026 00:00:00 GMT', ?, ?, ?)`,
		id, feedID, title, "https://x/"+id, content, content, starred)
	if err != nil {
		t.Fatalf("seed %s: %v", id, err)
	}
}

func searchIDs(t *testing.T, h interface{}, body string) []string {
	t.Helper()
	var res struct {
		Articles []struct{ ID string } `json:"articles"`
		Query    string                `json:"query"`
	}
	_ = json.Unmarshal([]byte(body), &res)
	ids := make([]string, len(res.Articles))
	for i, a := range res.Articles {
		ids[i] = a.ID
	}
	return ids
}

func TestSearchEmptyQuery(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	seedSearchRow(t, s, "a1", "fA", "Alpha", "body", 0)
	rec := do(h, "GET", "/api/search?q=%20", "", nil)
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"articles":[]`) || !strings.Contains(rec.Body.String(), `"query":""`) {
		t.Fatalf("empty-query body: %s", rec.Body.String())
	}
}

func TestSearchOneCharQuery(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	seedSearchRow(t, s, "a1", "fA", "Alpha", "body", 0)
	ids := searchIDs(t, h, do(h, "GET", "/api/search?q=a", "", nil).Body.String())
	if len(ids) != 1 || ids[0] != "a1" {
		t.Fatalf("one-char search: got %v, want [a1]", ids)
	}
}

func TestSearchScopes(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	seedSearchRow(t, s, "g1", "fA", "Golang news", "about golang", 0)
	seedSearchRow(t, s, "g2", "fB", "More golang", "golang again", 1) // starred, feed fB
	seedSearchRow(t, s, "x1", "fA", "Unrelated", "nothing here", 0)

	// Global: both golang rows, not the unrelated one.
	ids := searchIDs(t, h, do(h, "GET", "/api/search?q=golang", "", nil).Body.String())
	if len(ids) != 2 {
		t.Fatalf("global search: got %v, want 2", ids)
	}
	// Scope starred → only g2.
	ids = searchIDs(t, h, do(h, "GET", "/api/search?q=golang&scope=starred", "", nil).Body.String())
	if len(ids) != 1 || ids[0] != "g2" {
		t.Fatalf("starred scope: got %v, want [g2]", ids)
	}
	// Scope feed fA → only g1.
	ids = searchIDs(t, h, do(h, "GET", "/api/search?q=golang&scope=feed&feedId=fA", "", nil).Body.String())
	if len(ids) != 1 || ids[0] != "g1" {
		t.Fatalf("feed scope: got %v, want [g1]", ids)
	}
}

func TestSearchLikeEscape(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	seedSearchRow(t, s, "pct", "fA", "50% off sale", "discount", 0)
	seedSearchRow(t, s, "plain", "fA", "50 off", "no percent", 0)

	// "50%" must match the literal percent row only — the % is escaped, not a wildcard.
	ids := searchIDs(t, h, do(h, "GET", "/api/search?q=50%25", "", nil).Body.String()) // %25 = '%'
	if len(ids) != 1 || ids[0] != "pct" {
		t.Fatalf("escaped %% search: got %v, want [pct]", ids)
	}
}

func TestSearchSummaryTruncatedNoUpdatedAt(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	long := strings.Repeat("z", 500)
	seedSearchRow(t, s, "lng", "fA", "match token", long, 0)

	body := do(h, "GET", "/api/search?q=token", "", nil).Body.String()
	// summary sliced to 300; no updatedAt key present.
	var res struct {
		Articles []map[string]any `json:"articles"`
	}
	_ = json.Unmarshal([]byte(body), &res)
	if len(res.Articles) != 1 {
		t.Fatalf("got %d articles", len(res.Articles))
	}
	a := res.Articles[0]
	if summ, _ := a["summary"].(string); len(summ) != 300 {
		t.Errorf("summary length: got %d, want 300", len(summ))
	}
	if _, has := a["updatedAt"]; has {
		t.Error("search article must not carry updatedAt")
	}
	if a["content"] != "" {
		t.Errorf("search content should be empty, got %v", a["content"])
	}
}

// searchPage decodes one /api/search response with its paging fields.
type searchPage struct {
	Articles []struct {
		ID      string `json:"id"`
		PubDate string `json:"pubDate"`
	} `json:"articles"`
	Next  *string `json:"next"`
	Total *int    `json:"total"`
}

func getSearchPage(t *testing.T, h http.Handler, path string) searchPage {
	t.Helper()
	rec := do(h, "GET", path, "", nil)
	if rec.Code != 200 {
		t.Fatalf("%s: status %d: %s", path, rec.Code, rec.Body.String())
	}
	var p searchPage
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return p
}

// seedPaged inserts n matching rows, two per pub_ts so every page boundary can
// fall inside a tie, newest first by id order a000 > a001 > ….
func seedPaged(t *testing.T, s *Server, n int) {
	t.Helper()
	base := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	for i := 0; i < n; i++ {
		ts := base - int64(i/2)*3_600_000
		_, err := s.DB.Writer().Exec(
			`INSERT INTO article_states (article_id, feed_id, feed_name, title, link, pub_date, pub_ts)
			 VALUES (?, 'fA', 'F', 'match', ?, ?, ?)`,
			fmt.Sprintf("a%03d", 999-i), fmt.Sprintf("https://x/%d", i), dates.ISOString(ts), ts)
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestSearchPagesWithCursor(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	seedPaged(t, s, 205)

	seen := map[string]bool{}
	path := "/api/search?q=match"
	var pages []int
	for {
		p := getSearchPage(t, h, path)
		if p.Total != nil {
			t.Fatal("total without count=1")
		}
		pages = append(pages, len(p.Articles))
		for _, a := range p.Articles {
			if seen[a.ID] {
				t.Fatalf("article %s repeated", a.ID)
			}
			seen[a.ID] = true
		}
		if p.Next == nil {
			break
		}
		path = "/api/search?q=match&cursor=" + url.QueryEscape(*p.Next)
	}
	if fmt.Sprint(pages) != "[100 100 5]" || len(seen) != 205 {
		t.Fatalf("pages %v, %d distinct; want [100 100 5], 205", pages, len(seen))
	}
}

func TestSearchBeforeAndCount(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	seedPaged(t, s, 10) // 2026-06-01T00:00Z back to 2026-05-31T20:00Z, two per hour

	p := getSearchPage(t, h, "/api/search?q=match&count=1")
	if p.Total == nil || *p.Total != 10 || p.Next != nil {
		t.Fatalf("count=1: total %v next %v; want 10, null", p.Total, p.Next)
	}
	// before is exclusive: the two rows at 22:00Z and the four newer ones drop out.
	p = getSearchPage(t, h, "/api/search?q=match&count=1&before=2026-05-31T22:00:00Z")
	if len(p.Articles) != 4 || *p.Total != 4 || p.Articles[0].PubDate != "2026-05-31T21:00:00.000Z" {
		t.Fatalf("before: %d articles, total %v, first %+v", len(p.Articles), *p.Total, p.Articles)
	}
}

func TestSearchRejectsBadParams(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	for _, path := range []string{
		"/api/search?q=x&before=yesterday",
		"/api/search?q=x&cursor=nope",
		"/api/search?q=x&cursor=12_",
	} {
		if rec := do(h, "GET", path, "", nil); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", path, rec.Code)
		}
	}
}
