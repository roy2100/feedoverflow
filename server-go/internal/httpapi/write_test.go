package httpapi

import (
	"fmt"
	"strings"
	"sync"
	"testing"
)

// seedArticle inserts a minimal article_states row on the write pool.
func seedArticle(t *testing.T, s *Server, id, content string) {
	t.Helper()
	_, err := s.DB.Writer().Exec(
		`INSERT INTO article_states (article_id, feed_id, feed_name, title, link, pub_date, content, is_starred)
		 VALUES (?, '1', 'F', 'T', 'https://x/`+id+`', 'Fri, 01 Aug 2025 00:30:00 GMT', ?, 0)`,
		id, content)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
}

func isStarred(t *testing.T, s *Server, id string) int {
	t.Helper()
	var v int
	if err := s.DB.Reader().QueryRow(
		`SELECT is_starred FROM article_states WHERE article_id = ?`, id).Scan(&v); err != nil {
		t.Fatalf("read is_starred: %v", err)
	}
	return v
}

func TestStarPersistAndNoClobber(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	seedArticle(t, s, "aaa", "BODY")

	// Star with content omitted — must set is_starred=1 and NOT clobber content/title.
	body := `{"article":{"id":"aaa","feedId":"1","feedName":"F","title":"T2","link":"l","pubDate":"","content":""},"starred":true}`
	if rec := do(h, "POST", "/api/articles/star", body, jsonHdr()); rec.Code != 200 {
		t.Fatalf("star: %d %s", rec.Code, rec.Body.String())
	}
	if isStarred(t, s, "aaa") != 1 {
		t.Fatal("expected is_starred=1 after star")
	}
	var content, title string
	_ = s.DB.Reader().QueryRow(`SELECT content, title FROM article_states WHERE article_id='aaa'`).Scan(&content, &title)
	if content != "BODY" {
		t.Fatalf("content clobbered: %q", content)
	}
	if title != "T" {
		t.Fatalf("title clobbered: %q", title)
	}

	// Un-star.
	body = `{"article":{"id":"aaa","feedId":"1","title":"T"},"starred":false}`
	if rec := do(h, "POST", "/api/articles/star", body, jsonHdr()); rec.Code != 200 {
		t.Fatalf("unstar: %d", rec.Code)
	}
	if isStarred(t, s, "aaa") != 0 {
		t.Fatal("expected is_starred=0 after unstar")
	}

	// Missing id → 400.
	if rec := do(h, "POST", "/api/articles/star", `{"article":{},"starred":true}`, jsonHdr()); rec.Code != 400 {
		t.Fatalf("no-id: want 400, got %d", rec.Code)
	}
}

func TestCurrentArticle(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()

	if rec := do(h, "GET", "/api/current-article", "", nil); rec.Code != 404 {
		t.Fatalf("initial: want 404, got %d", rec.Code)
	}
	if rec := do(h, "POST", "/api/current-article", `{"article":{"id":"z","title":"Zed"}}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("post: %d", rec.Code)
	}
	rec := do(h, "GET", "/api/current-article", "", nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"id":"z"`) {
		t.Fatalf("get after post: %d %s", rec.Code, rec.Body.String())
	}
	// Clearing with null → 404 again.
	do(h, "POST", "/api/current-article", `{"article":null}`, jsonHdr())
	if rec := do(h, "GET", "/api/current-article", "", nil); rec.Code != 404 {
		t.Fatalf("after clear: want 404, got %d", rec.Code)
	}
}

func TestSettingsPatch(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()

	if rec := do(h, "PATCH", "/api/settings", `{"rsshub_base_url":"  http://x:1200/  "}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("patch: %d", rec.Code)
	}
	rec := do(h, "GET", "/api/settings", "", nil)
	if !strings.Contains(rec.Body.String(), `"rsshub_base_url":"http://x:1200/"`) {
		t.Fatalf("settings not updated/trimmed: %s", rec.Body.String())
	}
	// Feed freshness cleared.
	var nonNull int
	_ = s.DB.Reader().QueryRow(`SELECT COUNT(*) FROM feeds WHERE last_fetched_at IS NOT NULL`).Scan(&nonNull)
	if nonNull != 0 {
		t.Fatalf("expected all last_fetched_at NULL after patch, got %d non-null", nonNull)
	}
}

// TestConcurrentReadWriteBurst hammers reads + writes concurrently and asserts
// the DB stays consistent (single-writer discipline holds; no SQLITE_BUSY errors).
func TestConcurrentReadWriteBurst(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	for i := 0; i < 20; i++ {
		seedArticle(t, s, fmt.Sprintf("id%02d", i), "B")
	}

	var wg sync.WaitGroup
	for w := 0; w < 40; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			id := fmt.Sprintf("id%02d", w%20)
			starred := w%2 == 0
			body := fmt.Sprintf(`{"article":{"id":%q,"feedId":"1","title":"T"},"starred":%t}`, id, starred)
			if rec := do(h, "POST", "/api/articles/star", body, jsonHdr()); rec.Code != 200 {
				t.Errorf("star w=%d: %d", w, rec.Code)
			}
			do(h, "GET", "/api/all-articles", "", nil)
			do(h, "GET", "/api/starred", "", nil)
		}(w)
	}
	wg.Wait()

	var res string
	if err := s.DB.Reader().QueryRow(`PRAGMA integrity_check`).Scan(&res); err != nil {
		t.Fatalf("integrity_check: %v", err)
	}
	if res != "ok" {
		t.Fatalf("integrity_check = %q", res)
	}
}
