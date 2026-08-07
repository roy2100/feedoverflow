package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"rss-reader/server-go/internal/cache"
	"rss-reader/server-go/internal/feed"
)

// fakeParse returns a fixed parsed feed, so POST /api/feeds and the cache never
// touch the network in tests.
func fakeParse(title string, items ...feed.Item) cache.FetchFunc {
	return func(ctx context.Context, url string) (*feed.Parsed, error) {
		return &feed.Parsed{Title: title, Items: items}, nil
	}
}

// newFeedsServer builds a Server whose feed parse + cache fetch are stubbed.
func newFeedsServer(t *testing.T, fetch cache.FetchFunc) *Server {
	t.Helper()
	handle := testDB(t)
	return &Server{DB: handle, Cache: cache.New(handle, fetch), Parse: fetch}
}

// seedStarred inserts a starred article carrying feed_url (so adoptStarredOrphans
// can re-home it) for a given feed_id.
func seedStarred(t *testing.T, s *Server, id, feedID, feedURL string, starred int) {
	t.Helper()
	_, err := s.DB.Writer().Exec(
		`INSERT INTO article_states (article_id, feed_id, feed_name, feed_url, title, link, pub_date, content, is_starred)
		 VALUES (?, ?, 'F', ?, 'T', ?, 'Fri, 01 Aug 2025 00:30:00 GMT', 'B', ?)`,
		id, feedID, feedURL, "https://x/"+id, starred)
	if err != nil {
		t.Fatalf("seedStarred: %v", err)
	}
}

func feedRow(t *testing.T, s *Server, id string) (name, url string, ok bool) {
	t.Helper()
	err := s.DB.Reader().QueryRow(`SELECT name, url FROM feeds WHERE id = ?`, id).Scan(&name, &url)
	if err != nil {
		return "", "", false
	}
	return name, url, true
}

func TestFeedAddDupeAndValidation(t *testing.T) {
	s := newFeedsServer(t, fakeParse("Parsed Title"))
	h := s.NewLocalRouter()

	// Missing URL → 400.
	if rec := do(h, "POST", "/api/feeds", `{}`, jsonHdr()); rec.Code != 400 {
		t.Fatalf("no-url: want 400, got %d", rec.Code)
	}

	// Add with no name → uses parsed.title.
	rec := do(h, "POST", "/api/feeds", `{"url":"https://feed.example/rss"}`, jsonHdr())
	if rec.Code != 200 {
		t.Fatalf("add: %d %s", rec.Code, rec.Body.String())
	}
	var added struct{ ID, Name, URL string }
	_ = json.Unmarshal(rec.Body.Bytes(), &added)
	if added.Name != "Parsed Title" || added.URL != "https://feed.example/rss" || added.ID == "" {
		t.Fatalf("add response: %+v", added)
	}

	// Duplicate URL → 409.
	if rec := do(h, "POST", "/api/feeds", `{"url":"https://feed.example/rss"}`, jsonHdr()); rec.Code != 409 {
		t.Fatalf("dupe: want 409, got %d", rec.Code)
	}

	// Explicit name overrides parsed.title.
	rec = do(h, "POST", "/api/feeds", `{"url":"https://feed2.example/rss","name":"My Name"}`, jsonHdr())
	_ = json.Unmarshal(rec.Body.Bytes(), &added)
	if added.Name != "My Name" {
		t.Fatalf("name override: %+v", added)
	}
}

func TestFeedRename(t *testing.T) {
	s := newFeedsServer(t, fakeParse("Orig"))
	h := s.NewLocalRouter()
	rec := do(h, "POST", "/api/feeds", `{"url":"https://f.example/rss"}`, jsonHdr())
	var added struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &added)

	if rec := do(h, "PATCH", "/api/feeds/"+added.ID, `{"name":"Renamed"}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("rename: %d", rec.Code)
	}
	name, _, ok := feedRow(t, s, added.ID)
	if !ok || name != "Renamed" {
		t.Fatalf("after rename: name=%q ok=%v", name, ok)
	}

	// Unknown id → 404.
	if rec := do(h, "PATCH", "/api/feeds/nope", `{"name":"x"}`, jsonHdr()); rec.Code != 404 {
		t.Fatalf("rename unknown: want 404, got %d", rec.Code)
	}
}

// TestFeedRenameEmpty guards the fixed latent bug: an empty/whitespace name is
// rejected with 400 rather than reaching the NOT NULL name column and 500ing.
func TestFeedRenameEmpty(t *testing.T) {
	s := newFeedsServer(t, fakeParse("Orig"))
	h := s.NewLocalRouter()
	rec := do(h, "POST", "/api/feeds", `{"url":"https://f.example/rss"}`, jsonHdr())
	var added struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &added)

	for _, body := range []string{`{"name":""}`, `{"name":"   "}`, `{}`} {
		if rec := do(h, "PATCH", "/api/feeds/"+added.ID, body, jsonHdr()); rec.Code != 400 {
			t.Fatalf("empty rename %s: want 400, got %d", body, rec.Code)
		}
	}
	// The name is untouched after the rejected renames.
	if name, _, _ := feedRow(t, s, added.ID); name != "Orig" {
		t.Fatalf("rejected rename mutated name: %q", name)
	}
}

// stubParse is fakeParse with two knobs the URL-edit tests need: it counts calls
// (to prove a no-op PATCH costs no upstream fetch) and can be made to fail
// mid-test (to prove an unparseable new URL is rejected before anything is
// written).
func stubParse(calls *int, failWith *error) cache.FetchFunc {
	return func(_ context.Context, _ string) (*feed.Parsed, error) {
		*calls++
		if *failWith != nil {
			return nil, *failWith
		}
		return &feed.Parsed{Title: "F"}, nil
	}
}

func articleHome(t *testing.T, s *Server, articleID string) (feedID, feedURL string) {
	t.Helper()
	err := s.DB.Reader().QueryRow(
		`SELECT feed_id, feed_url FROM article_states WHERE article_id = ?`, articleID).
		Scan(&feedID, &feedURL)
	if err != nil {
		t.Fatalf("articleHome(%s): %v", articleID, err)
	}
	return feedID, feedURL
}

// TestFeedURLEdit is the point of the feature: repointing a feed at a new source
// keeps every article it already has. The delete+re-add that used to be the only
// way to switch would have purged the non-starred one outright.
func TestFeedURLEdit(t *testing.T) {
	const oldURL, newURL = "https://old.example/rss", "https://new.example/rss"
	calls := 0
	var failWith error
	s := newFeedsServer(t, stubParse(&calls, &failWith))
	h := s.NewLocalRouter()

	rec := do(h, "POST", "/api/feeds", `{"url":"`+oldURL+`"}`, jsonHdr())
	var added struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &added)

	seedStarred(t, s, "kept", added.ID, oldURL, 1)
	seedStarred(t, s, "plain", added.ID, oldURL, 0)
	// A fetched feed: the edit must clear this, or the new URL wouldn't be read
	// for up to CacheTTL.
	if _, err := s.DB.Writer().Exec(
		`UPDATE feeds SET last_fetched_at = 1 WHERE id = ?`, added.ID); err != nil {
		t.Fatalf("seed last_fetched_at: %v", err)
	}

	if rec := do(h, "PATCH", "/api/feeds/"+added.ID,
		`{"url":"`+newURL+`"}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("edit url: %d %s", rec.Code, rec.Body.String())
	}

	if _, url, ok := feedRow(t, s, added.ID); !ok || url != newURL {
		t.Fatalf("after edit: url=%q ok=%v", url, ok)
	}
	var last sql.NullInt64
	_ = s.DB.Reader().QueryRow(`SELECT last_fetched_at FROM feeds WHERE id = ?`, added.ID).Scan(&last)
	if last.Valid {
		t.Errorf("last_fetched_at not cleared: %d", last.Int64)
	}

	// Both articles survive, still homed to the same feed, now carrying the new
	// feed_url so a later delete+re-add can still adopt the starred one.
	for _, id := range []string{"kept", "plain"} {
		feedID, feedURL := articleHome(t, s, id)
		if feedID != added.ID {
			t.Errorf("%s re-homed: feed_id=%q, want %q", id, feedID, added.ID)
		}
		if feedURL != newURL {
			t.Errorf("%s feed_url=%q, want %q", id, feedURL, newURL)
		}
	}
}

// TestFeedURLEditRejected: every rejection path leaves the feed and its articles
// exactly as they were — a refused edit must not half-apply.
func TestFeedURLEditRejected(t *testing.T) {
	const urlA, urlB = "https://a.example/rss", "https://b.example/rss"
	calls := 0
	var failWith error
	s := newFeedsServer(t, stubParse(&calls, &failWith))
	h := s.NewLocalRouter()

	rec := do(h, "POST", "/api/feeds", `{"url":"`+urlA+`"}`, jsonHdr())
	var a struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &a)
	do(h, "POST", "/api/feeds", `{"url":"`+urlB+`"}`, jsonHdr())
	seedStarred(t, s, "art", a.ID, urlA, 1)

	// Another feed already holds this URL.
	if rec := do(h, "PATCH", "/api/feeds/"+a.ID, `{"url":"`+urlB+`"}`, jsonHdr()); rec.Code != 409 {
		t.Fatalf("taken url: want 409, got %d", rec.Code)
	}
	// Empty / whitespace-only.
	for _, body := range []string{`{"url":""}`, `{"url":"   "}`} {
		if rec := do(h, "PATCH", "/api/feeds/"+a.ID, body, jsonHdr()); rec.Code != 400 {
			t.Fatalf("empty url %s: want 400, got %d", body, rec.Code)
		}
	}
	// Unknown feed.
	if rec := do(h, "PATCH", "/api/feeds/nope", `{"url":"`+urlB+`"}`, jsonHdr()); rec.Code != 404 {
		t.Fatalf("unknown id: want 404, got %d", rec.Code)
	}
	// The new address doesn't parse.
	failWith = errors.New("boom")
	if rec := do(h, "PATCH", "/api/feeds/"+a.ID,
		`{"url":"https://broken.example/rss"}`, jsonHdr()); rec.Code != 400 {
		t.Fatalf("unparseable url: want 400, got %d", rec.Code)
	}
	failWith = nil

	if _, url, _ := feedRow(t, s, a.ID); url != urlA {
		t.Errorf("rejected edit changed url: %q", url)
	}
	if _, feedURL := articleHome(t, s, "art"); feedURL != urlA {
		t.Errorf("rejected edit changed article feed_url: %q", feedURL)
	}
}

// TestFeedURLEditNoop: the client may echo the whole feed back, so a PATCH whose
// url matches the stored one must not fetch upstream to "validate" what is
// already in the database. A rename riding along still applies.
func TestFeedURLEditNoop(t *testing.T) {
	const url = "https://same.example/rss"
	calls := 0
	var failWith error
	s := newFeedsServer(t, stubParse(&calls, &failWith))
	h := s.NewLocalRouter()

	rec := do(h, "POST", "/api/feeds", `{"url":"`+url+`"}`, jsonHdr())
	var added struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &added)
	afterAdd := calls

	if rec := do(h, "PATCH", "/api/feeds/"+added.ID,
		`{"url":"`+url+`","name":"Renamed"}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("noop edit: %d %s", rec.Code, rec.Body.String())
	}
	if calls != afterAdd {
		t.Errorf("unchanged url fetched upstream: %d calls, want %d", calls, afterAdd)
	}
	if name, _, _ := feedRow(t, s, added.ID); name != "Renamed" {
		t.Errorf("rename alongside a no-op url not applied: %q", name)
	}
}

func TestFeedDeleteKeepsStarredPurgesRest(t *testing.T) {
	s := newFeedsServer(t, fakeParse("F"))
	h := s.NewLocalRouter()
	rec := do(h, "POST", "/api/feeds", `{"url":"https://del.example/rss"}`, jsonHdr())
	var added struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &added)

	seedStarred(t, s, "keep", added.ID, "https://del.example/rss", 1)
	seedStarred(t, s, "purge", added.ID, "https://del.example/rss", 0)

	if rec := do(h, "DELETE", "/api/feeds/"+added.ID, "", nil); rec.Code != 200 {
		t.Fatalf("delete: %d", rec.Code)
	}
	if _, _, ok := feedRow(t, s, added.ID); ok {
		t.Fatal("feed row should be gone")
	}
	// Non-starred purged, starred kept.
	var keepN, purgeN int
	_ = s.DB.Reader().QueryRow(`SELECT COUNT(*) FROM article_states WHERE article_id='keep'`).Scan(&keepN)
	_ = s.DB.Reader().QueryRow(`SELECT COUNT(*) FROM article_states WHERE article_id='purge'`).Scan(&purgeN)
	if keepN != 1 {
		t.Errorf("starred article purged (keepN=%d)", keepN)
	}
	if purgeN != 0 {
		t.Errorf("non-starred article not purged (purgeN=%d)", purgeN)
	}

	// Delete unknown → 404.
	if rec := do(h, "DELETE", "/api/feeds/nope", "", nil); rec.Code != 404 {
		t.Fatalf("delete unknown: want 404, got %d", rec.Code)
	}
}

func TestFeedReAddReAdoptsStarredOrphans(t *testing.T) {
	url := "https://orphan.example/rss"
	s := newFeedsServer(t, fakeParse("F"))
	h := s.NewLocalRouter()

	rec := do(h, "POST", "/api/feeds", `{"url":"`+url+`"}`, jsonHdr())
	var first struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &first)

	// A starred article originating from this feed, carrying feed_url.
	seedStarred(t, s, "star1", first.ID, url, 1)

	// Delete the feed — starred row becomes an orphan (feed_id no longer live).
	do(h, "DELETE", "/api/feeds/"+first.ID, "", nil)

	// Re-add the SAME url → new id; the orphan is re-homed onto it.
	rec = do(h, "POST", "/api/feeds", `{"url":"`+url+`"}`, jsonHdr())
	var second struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &second)
	if second.ID == first.ID {
		t.Fatal("re-add should mint a new id")
	}

	var adoptedFeedID string
	_ = s.DB.Reader().QueryRow(`SELECT feed_id FROM article_states WHERE article_id='star1'`).Scan(&adoptedFeedID)
	if adoptedFeedID != second.ID {
		t.Fatalf("orphan not re-adopted: feed_id=%q, want %q", adoptedFeedID, second.ID)
	}
}

func TestOPMLImportSkipsDupes(t *testing.T) {
	s := newFeedsServer(t, fakeParse("F"))
	h := s.NewLocalRouter()

	// Pre-existing feed A.
	do(h, "POST", "/api/feeds", `{"url":"https://a.example/feed"}`, jsonHdr())

	opml := `<opml version="1.0"><body>
	  <outline text="A" xmlUrl="https://a.example/feed"/>
	  <outline text="B" xmlUrl="https://b.example/feed"/>
	  <outline text="C" xmlUrl="https://c.example/feed"/>
	</body></opml>`
	body, _ := json.Marshal(map[string]string{"opml": opml})
	rec := do(h, "POST", "/api/feeds/import-opml", string(body), jsonHdr())
	if rec.Code != 200 {
		t.Fatalf("import: %d %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Imported int                          `json:"imported"`
		Skipped  int                          `json:"skipped"`
		Feeds    []struct{ Name, URL string } `json:"feeds"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if res.Imported != 2 || res.Skipped != 1 {
		t.Fatalf("import counts: imported=%d skipped=%d (want 2/1)", res.Imported, res.Skipped)
	}

	// Missing opml → 400.
	if rec := do(h, "POST", "/api/feeds/import-opml", `{}`, jsonHdr()); rec.Code != 400 {
		t.Fatalf("no-opml: want 400, got %d", rec.Code)
	}
}

func TestGetFeedArticles(t *testing.T) {
	// A brand-new feed with no rows → ensureFresh awaits one fetch, which persists
	// the stubbed items; the handler then serves them.
	items := []feed.Item{
		{Link: "https://x/1", Title: "One", Content: "body one", PubDate: "Fri, 01 Aug 2025 00:30:00 GMT"},
	}
	s := newFeedsServer(t, fakeParse("Fresh Feed", items...))
	h := s.NewLocalRouter()

	rec := do(h, "POST", "/api/feeds", `{"url":"https://fresh.example/rss"}`, jsonHdr())
	var added struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &added)

	rec = do(h, "GET", "/api/feeds/"+added.ID+"/articles", "", nil)
	if rec.Code != 200 {
		t.Fatalf("feed articles: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"feedName"`) || !strings.Contains(rec.Body.String(), `"One"`) {
		t.Fatalf("feed articles body missing content: %s", rec.Body.String())
	}

	// Unknown feed → 404.
	if rec := do(h, "GET", "/api/feeds/nope/articles", "", nil); rec.Code != 404 {
		t.Fatalf("unknown feed: want 404, got %d", rec.Code)
	}
}
