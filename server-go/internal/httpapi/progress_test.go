package httpapi

import (
	"encoding/json"
	"fmt"
	"testing"
)

func progressMap(t *testing.T, s *Server) map[string]int {
	t.Helper()
	rec := do(s.NewLocalRouter(), "GET", "/api/podcast-progress", "", nil)
	if rec.Code != 200 {
		t.Fatalf("GET progress: %d %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Progress map[string]int `json:"progress"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode progress: %v (%s)", err, rec.Body.String())
	}
	return got.Progress
}

func TestPodcastProgressRoundTrip(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	seedArticle(t, s, "ep1", "B")
	seedArticle(t, s, "ep2", "B")

	// Nothing played yet — an empty object, not null.
	if got := progressMap(t, s); len(got) != 0 {
		t.Fatalf("initial: want empty, got %v", got)
	}
	if body := do(h, "GET", "/api/podcast-progress", "", nil).Body.String(); body == `{"progress":null}` {
		t.Fatalf("empty progress serialized as null: %s", body)
	}

	// Fractional seconds round to whole ones.
	if rec := do(h, "POST", "/api/podcast-progress", `{"id":"ep1","position":630.4,"duration":1800}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("post: %d %s", rec.Code, rec.Body.String())
	}
	do(h, "POST", "/api/podcast-progress", `{"id":"ep2","position":12,"duration":1800}`, jsonHdr())
	if got := progressMap(t, s); got["ep1"] != 630 || got["ep2"] != 12 {
		t.Fatalf("after post: %v", got)
	}

	// A later write for the same episode replaces the position.
	do(h, "POST", "/api/podcast-progress", `{"id":"ep1","position":900,"duration":1800}`, jsonHdr())
	if got := progressMap(t, s); got["ep1"] != 900 {
		t.Fatalf("after re-post: %v", got)
	}

	// Delete clears one episode and leaves the others alone.
	if rec := do(h, "DELETE", "/api/podcast-progress/ep1", "", nil); rec.Code != 200 {
		t.Fatalf("delete: %d", rec.Code)
	}
	got := progressMap(t, s)
	if _, ok := got["ep1"]; ok {
		t.Fatalf("ep1 still present after delete: %v", got)
	}
	if got["ep2"] != 12 {
		t.Fatalf("ep2 lost: %v", got)
	}
}

// A position must never clobber the article it belongs to, and must never invent
// one: writing progress for an id that was trimmed away is a silent no-op.
func TestPodcastProgressNeverWritesArticleRows(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	seedArticle(t, s, "ep1", "BODY")

	do(h, "POST", "/api/podcast-progress", `{"id":"ep1","position":300}`, jsonHdr())
	var content, title string
	if err := s.DB.Reader().QueryRow(
		`SELECT content, title FROM article_states WHERE article_id='ep1'`).Scan(&content, &title); err != nil {
		t.Fatalf("read ep1: %v", err)
	}
	if content != "BODY" || title != "T" {
		t.Fatalf("article clobbered: content=%q title=%q", content, title)
	}

	// Unknown id: 200 (progress is never an error the listener sees) and no row.
	if rec := do(h, "POST", "/api/podcast-progress", `{"id":"ghost","position":300}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("unknown id: want 200, got %d", rec.Code)
	}
	if rec := do(h, "DELETE", "/api/podcast-progress/ghost", "", nil); rec.Code != 200 {
		t.Fatalf("delete unknown id: want 200, got %d", rec.Code)
	}
	var n int
	if err := s.DB.Reader().QueryRow(
		`SELECT COUNT(*) FROM article_states WHERE article_id='ghost'`).Scan(&n); err != nil {
		t.Fatalf("count ghost: %v", err)
	}
	if n != 0 {
		t.Fatal("a progress ping created an article_states row")
	}
}

func TestPodcastProgressRejectsBadInput(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	seedArticle(t, s, "ep1", "B")

	for _, body := range []string{
		`{"position":300}`,              // no id
		`{"id":"ep1"}`,                  // no position
		`{"id":"ep1","position":0}`,     // zero — a reset src must not erase a real position
		`{"id":"ep1","position":-5}`,    // negative
		`not json`,                      // unparseable
		`{"id":"ep1","position":"abc"}`, // wrong type
	} {
		if rec := do(h, "POST", "/api/podcast-progress", body, jsonHdr()); rec.Code != 400 {
			t.Errorf("%s: want 400, got %d %s", body, rec.Code, rec.Body.String())
		}
	}
	if got := progressMap(t, s); len(got) != 0 {
		t.Fatalf("a rejected write landed anyway: %v", got)
	}
}

// The read is capped and newest-first: the client hydrates a bounded map from it.
func TestPodcastProgressCapsAtRecentEpisodes(t *testing.T) {
	s := &Server{DB: testDB(t)}
	total := progressLimit + 20
	for i := range total {
		id := fmt.Sprintf("ep%03d", i)
		seedArticle(t, s, id, "B")
		// play_updated_at ascending with i, so ep000 is the oldest.
		if _, err := s.DB.Writer().Exec(
			`UPDATE article_states SET play_position = ?, play_updated_at = ? WHERE article_id = ?`,
			100+i, 1_700_000_000_000+int64(i), id); err != nil {
			t.Fatalf("seed progress: %v", err)
		}
	}

	got := progressMap(t, s)
	if len(got) != progressLimit {
		t.Fatalf("want %d entries, got %d", progressLimit, len(got))
	}
	newest := fmt.Sprintf("ep%03d", total-1)
	if _, ok := got[newest]; !ok {
		t.Fatalf("newest episode %s missing", newest)
	}
	if _, ok := got["ep000"]; ok {
		t.Fatal("oldest episode survived the cap")
	}
}
