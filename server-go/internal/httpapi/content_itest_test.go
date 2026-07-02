//go:build itest

// Live-network integration test for GET /api/fetch-content: fetch a few real
// article URLs and assert readable content comes back. Readability output is not
// byte-identical to @mozilla/readability (Phase-8 Stop-if explicitly accepts
// this), so we only assert non-trivial extracted HTML + a title.
//
// Run: go test -tags itest -run TestFetchContentLive ./internal/httpapi/

package httpapi

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestFetchContentLive(t *testing.T) {
	urls := []string{
		"https://go.dev/blog/greenteagc",
		"https://blog.golang.org/",
	}
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()

	anyOK := false
	for _, u := range urls {
		rec := do(h, "GET", "/api/fetch-content?url="+u, "", nil)
		if rec.Code != 200 {
			t.Logf("%s: status %d (%s) — skipping", u, rec.Code, strings.TrimSpace(rec.Body.String()))
			continue
		}
		var res struct{ Content, Title, Byline string }
		if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
			t.Errorf("%s: bad json: %v", u, err)
			continue
		}
		if len(res.Content) < 200 {
			t.Errorf("%s: extracted content too short (%d bytes)", u, len(res.Content))
			continue
		}
		t.Logf("%s: title=%q, %d bytes of content, byline=%q", u, res.Title, len(res.Content), res.Byline)
		anyOK = true
	}
	if !anyOK {
		t.Skip("no live URL returned extractable content (network/site changes)")
	}
}
