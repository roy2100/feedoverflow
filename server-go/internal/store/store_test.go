package store_test

import (
	"database/sql"
	"testing"

	"rss-reader/server-go/internal/articles"
	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/store"

	_ "github.com/mattn/go-sqlite3"
)

// newTestDB opens an isolated on-disk DB (mattn/go-sqlite3 needs a real path for
// the reader/writer split) with the production schema, then clears the four
// seeded default feeds so each test starts from a known-empty feeds table. The
// seeded rsshub_base_url setting is left in place (it equals ResolveURL's own
// default, so read tests stay deterministic).
func newTestDB(t *testing.T) *db.DB {
	t.Helper()
	handle, err := db.OpenHandle(t.TempDir() + "/t.db")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := db.InitSchema(handle.Writer()); err != nil {
		t.Fatalf("schema: %v", err)
	}
	if _, err := handle.Writer().Exec(`DELETE FROM feeds`); err != nil {
		t.Fatalf("clear seed feeds: %v", err)
	}
	t.Cleanup(func() { handle.Close() })
	return handle
}

// af is a compact article_states fixture; zero values map to empty columns.
type af struct {
	id, feedID, feedName, feedURL string
	title, link, pubDate          string
	pubTs                         int64
	summary, content, author      string
	audioURL, audioDuration       string
	isStarred                     int
	updatedAt                     string // "" -> datetime('now')
	contentUpdatedAt              any    // nil -> NULL
	starredAt                     any    // nil -> NULL
}

func insertArticle(t *testing.T, w *sql.DB, a af) {
	t.Helper()
	var updated any
	if a.updatedAt != "" {
		updated = a.updatedAt
	}
	_, err := w.Exec(`INSERT INTO article_states
		(article_id,feed_id,feed_name,feed_url,title,link,pub_date,pub_ts,summary,content,author,
		 audio_url,audio_duration,is_starred,updated_at,content_updated_at,starred_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,datetime('now')),?,?)`,
		a.id, a.feedID, a.feedName, a.feedURL, a.title, a.link, a.pubDate, a.pubTs,
		a.summary, a.content, a.author, a.audioURL, a.audioDuration, a.isStarred,
		updated, a.contentUpdatedAt, a.starredAt)
	if err != nil {
		t.Fatalf("insertArticle %q: %v", a.id, err)
	}
}

func insertFeed(t *testing.T, w *sql.DB, id, name, url string, last any) {
	t.Helper()
	if _, err := w.Exec(
		`INSERT INTO feeds (id,name,url,last_fetched_at) VALUES (?,?,?,?)`, id, name, url, last); err != nil {
		t.Fatalf("insertFeed %q: %v", id, err)
	}
}

// articleIDs projects article_id out of a query result for order assertions.
func articleIDs(rows []articles.Row) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.ArticleID
	}
	return out
}

func eqStrings(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("length: got %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("at %d: got %v, want %v", i, got, want)
		}
	}
}

func TestListFeeds(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	// Insert out of id-sort order to prove rowid ordering (insertion order).
	last := int64(1700000000000)
	insertFeed(t, w, "z", "Zeta", "http://z", last)
	insertFeed(t, w, "a", "Alpha", "http://a", nil)

	feeds, err := store.ListFeeds(h.Reader())
	if err != nil {
		t.Fatal(err)
	}
	if len(feeds) != 2 {
		t.Fatalf("want 2 feeds, got %d", len(feeds))
	}
	if feeds[0].ID != "z" || feeds[1].ID != "a" {
		t.Fatalf("rowid order broken: %s, %s", feeds[0].ID, feeds[1].ID)
	}
	if feeds[0].LastFetchedAt == nil || *feeds[0].LastFetchedAt != last {
		t.Fatalf("last_fetched_at not surfaced: %+v", feeds[0].LastFetchedAt)
	}
	if feeds[1].LastFetchedAt != nil {
		t.Fatalf("NULL last_fetched_at should map to nil, got %v", *feeds[1].LastFetchedAt)
	}

	// Empty table -> non-nil empty slice (JSON []).
	if _, err := w.Exec(`DELETE FROM feeds`); err != nil {
		t.Fatal(err)
	}
	empty, err := store.ListFeeds(h.Reader())
	if err != nil {
		t.Fatal(err)
	}
	if empty == nil || len(empty) != 0 {
		t.Fatalf("want empty non-nil slice, got %#v", empty)
	}
}

func TestFeedIDs(t *testing.T) {
	h := newTestDB(t)
	insertFeed(t, h.Writer(), "b", "B", "http://b", nil)
	insertFeed(t, h.Writer(), "a", "A", "http://a", nil)
	got, err := store.FeedIDs(h.Reader())
	if err != nil {
		t.Fatal(err)
	}
	eqStrings(t, got, []string{"b", "a"}) // rowid (insertion) order, not id-sorted
}

func TestNewestAndSinceGlobal(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	insertArticle(t, w, af{id: "old", title: "old", link: "l1", pubTs: 10})
	insertArticle(t, w, af{id: "mid", title: "mid", link: "l2", pubTs: 20})
	insertArticle(t, w, af{id: "new", title: "new", link: "l3", pubTs: 30})

	all, err := store.NewestGlobal(h.Reader(), 500)
	if err != nil {
		t.Fatal(err)
	}
	eqStrings(t, articleIDs(all), []string{"new", "mid", "old"})

	// LIMIT is honoured.
	two, err := store.NewestGlobal(h.Reader(), 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(two) != 2 || two[0].ArticleID != "new" {
		t.Fatalf("limit broken: %+v", two)
	}

	// SinceGlobal filters by cutoff, keeps DESC order.
	since, err := store.SinceGlobal(h.Reader(), 20, 500)
	if err != nil {
		t.Fatal(err)
	}
	eqStrings(t, articleIDs(since), []string{"new", "mid"})
}

func TestNewestAndSinceByFeed(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	insertArticle(t, w, af{id: "a1", feedID: "f1", link: "la1", pubTs: 10})
	insertArticle(t, w, af{id: "a2", feedID: "f1", link: "la2", pubTs: 30})
	insertArticle(t, w, af{id: "b1", feedID: "f2", link: "lb1", pubTs: 40})

	f1, err := store.NewestByFeed(h.Reader(), "f1", 500)
	if err != nil {
		t.Fatal(err)
	}
	eqStrings(t, articleIDs(f1), []string{"a2", "a1"})

	since, err := store.SinceByFeed(h.Reader(), "f1", 20, 500)
	if err != nil {
		t.Fatal(err)
	}
	eqStrings(t, articleIDs(since), []string{"a2"})
}

func TestStarredAndCount(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	// starred_at drives the sort; pub_ts is inverted to prove it's not the key.
	// s_recent has the OLDER pub_ts but the NEWER star time, so it must come first.
	insertArticle(t, w, af{id: "s_stale", link: "l1", isStarred: 1, pubTs: 2000, starredAt: int64(1000)})
	insertArticle(t, w, af{id: "s_recent", link: "l2", isStarred: 1, pubTs: 1000, starredAt: int64(2000)})
	insertArticle(t, w, af{id: "plain", link: "l3", isStarred: 0})

	starred, err := store.Starred(h.Reader())
	if err != nil {
		t.Fatal(err)
	}
	// Newest starred_at first; unstarred excluded.
	eqStrings(t, articleIDs(starred), []string{"s_recent", "s_stale"})

	n, err := store.StarredCount(h.Reader())
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("StarredCount = %d, want 2", n)
	}
}

func TestPodcasts(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	insertArticle(t, w, af{id: "p_new", link: "l1", pubDate: "2021-05-01", audioURL: "http://a/2.mp3"})
	insertArticle(t, w, af{id: "p_old", link: "l2", pubDate: "2020-05-01", audioURL: "http://a/1.mp3"})
	insertArticle(t, w, af{id: "noaudio", link: "l3", pubDate: "2022-05-01"}) // empty audio_url

	pods, err := store.Podcasts(h.Reader())
	if err != nil {
		t.Fatal(err)
	}
	// Only audio-bearing rows, ordered by pub_date DESC (string sort).
	eqStrings(t, articleIDs(pods), []string{"p_new", "p_old"})
}

func TestLookupContent(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	insertArticle(t, w, af{id: "has_content", link: "l1", content: "full body", summary: "sum"})
	insertArticle(t, w, af{id: "only_summary", link: "l2", content: "", summary: "the summary"})
	insertArticle(t, w, af{id: "both_empty", link: "l3"})

	cases := []struct{ id, want string }{
		{"has_content", "full body"},    // content wins
		{"only_summary", "the summary"}, // falls back to summary
		{"both_empty", ""},              // neither
		{"missing", ""},                 // no row -> "" (sql.ErrNoRows)
	}
	for _, c := range cases {
		got, err := store.LookupContent(h.Reader(), c.id)
		if err != nil {
			t.Fatalf("%s: %v", c.id, err)
		}
		if got != c.want {
			t.Fatalf("LookupContent(%s) = %q, want %q", c.id, got, c.want)
		}
	}
}

func TestFeedHasRows(t *testing.T) {
	h := newTestDB(t)
	insertArticle(t, h.Writer(), af{id: "a1", feedID: "f1", link: "l1", pubTs: 1})

	yes, err := store.FeedHasRows(h.Reader(), "f1")
	if err != nil {
		t.Fatal(err)
	}
	if !yes {
		t.Fatal("FeedHasRows(f1) = false, want true")
	}
	no, err := store.FeedHasRows(h.Reader(), "ghost")
	if err != nil {
		t.Fatal(err)
	}
	if no {
		t.Fatal("FeedHasRows(ghost) = true, want false")
	}
}

func TestResolveURL(t *testing.T) {
	h := newTestDB(t)

	// Non-rsshub URLs (and empty) pass through untouched.
	for _, u := range []string{"", "http://example.com/feed", "https://x.y/z"} {
		got, err := store.ResolveURL(h.Reader(), u)
		if err != nil {
			t.Fatal(err)
		}
		if got != u {
			t.Fatalf("passthrough %q -> %q", u, got)
		}
	}

	// Seeded base (http://localhost:1200) expands rsshub://path.
	got, err := store.ResolveURL(h.Reader(), "rsshub://foo/bar")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://localhost:1200/foo/bar" {
		t.Fatalf("seeded base expand: %q", got)
	}

	// Overridden base with a trailing slash is trimmed exactly once.
	if err := store.UpdateSetting(h.Writer(), "rsshub_base_url", "http://host:1200/"); err != nil {
		t.Fatal(err)
	}
	got, err = store.ResolveURL(h.Reader(), "rsshub://p")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://host:1200/p" {
		t.Fatalf("trailing-slash trim: %q", got)
	}

	// Missing setting row -> default base (exercises the ErrNoRows branch).
	if _, err := h.Writer().Exec(`DELETE FROM settings WHERE key = 'rsshub_base_url'`); err != nil {
		t.Fatal(err)
	}
	got, err = store.ResolveURL(h.Reader(), "rsshub://q")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://localhost:1200/q" {
		t.Fatalf("default fallback: %q", got)
	}
}

func TestSearch(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	insertArticle(t, w, af{id: "t", feedID: "f1", link: "l1", title: "golang tips", pubDate: "2021-01-03", isStarred: 1})
	insertArticle(t, w, af{id: "s", feedID: "f1", link: "l2", title: "x", summary: "about golang", pubDate: "2021-01-02"})
	insertArticle(t, w, af{id: "c", feedID: "f2", link: "l3", title: "y", content: "deep golang dive", pubDate: "2021-01-01"})
	insertArticle(t, w, af{id: "u_hit", feedID: "f2", link: "l4", title: "a_b literal", pubDate: "2020-01-01"})
	insertArticle(t, w, af{id: "u_miss", feedID: "f2", link: "l5", title: "axb other", pubDate: "2020-01-02"})

	// Unscoped: matches title/summary/content, newest pub_date first.
	res, err := store.Search(h.Reader(), "%golang%", "", "")
	if err != nil {
		t.Fatal(err)
	}
	eqStrings(t, articleIDs(res), []string{"t", "s", "c"})

	// starred scope.
	res, err = store.Search(h.Reader(), "%golang%", "starred", "")
	if err != nil {
		t.Fatal(err)
	}
	eqStrings(t, articleIDs(res), []string{"t"})

	// feed scope.
	res, err = store.Search(h.Reader(), "%golang%", "feed", "f2")
	if err != nil {
		t.Fatal(err)
	}
	eqStrings(t, articleIDs(res), []string{"c"})

	// ESCAPE '\': "a\_b" matches the literal underscore only.
	res, err = store.Search(h.Reader(), `%a\_b%`, "", "")
	if err != nil {
		t.Fatal(err)
	}
	eqStrings(t, articleIDs(res), []string{"u_hit"})
}

func TestSettings(t *testing.T) {
	h := newTestDB(t)
	// Fresh schema seeds one key.
	m, err := store.Settings(h.Reader())
	if err != nil {
		t.Fatal(err)
	}
	if m["rsshub_base_url"] != "http://localhost:1200" {
		t.Fatalf("seeded setting missing: %#v", m)
	}
	if err := store.UpdateSetting(h.Writer(), "theme", "dark"); err != nil {
		t.Fatal(err)
	}
	m, err = store.Settings(h.Reader())
	if err != nil {
		t.Fatal(err)
	}
	if m["theme"] != "dark" || len(m) != 2 {
		t.Fatalf("settings map wrong: %#v", m)
	}
}
