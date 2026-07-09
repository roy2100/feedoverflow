package httpapi

import (
	"encoding/json"
	"strings"
	"testing"
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
