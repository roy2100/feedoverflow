package feed_test

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	_ "time/tzdata"

	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/feed"
	"rss-reader/server-go/internal/store"
)

// TestMain pins the local zone to Asia/Shanghai so zoneless date parsing matches
// the production Mac (and the Node oracle, which ran in the same zone).
func TestMain(m *testing.M) {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		panic(err)
	}
	time.Local = loc
	os.Exit(m.Run())
}

// oracleRow is the subset of article_states the Node oracle dumps — the
// field-mapping surface (timestamps excluded; pub_ts is a pure function of
// pub_date, already covered by the Phase-2 parity tests).
type oracleRow struct {
	ArticleID     string  `json:"article_id"`
	FeedID        string  `json:"feed_id"`
	FeedName      string  `json:"feed_name"`
	FeedURL       string  `json:"feed_url"`
	Title         string  `json:"title"`
	Link          string  `json:"link"`
	PubDate       string  `json:"pub_date"`
	Summary       string  `json:"summary"`
	Content       string  `json:"content"`
	Author        string  `json:"author"`
	AudioURL      *string `json:"audio_url"`
	AudioDuration *string `json:"audio_duration"`
	IsStarred     int     `json:"is_starred"`
}

var parityFeeds = []struct {
	name, xml, feedID, feedName, feedURL string
}{
	{"coindesk", "coindesk", "c1", "CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"},
	{"sspai", "sspai", "s1", "少数派", "https://sspai.com/feed"},
	{"reddit", "reddit", "r1", "RSS", "https://www.reddit.com/r/rss.rss"},
}

// TestPersistParity parses each saved fixture with gofeed → maps → persists, then
// diffs the resulting article_states rows against the Node persist oracle
// (gen_persist_oracle.mjs run on the SAME bytes). This is the Phase-6 Stop-if
// guard: any field-mapping divergence surfaces here.
func TestPersistParity(t *testing.T) {
	for _, f := range parityFeeds {
		t.Run(f.name, func(t *testing.T) {
			want := loadOracle(t, "testdata/oracle-"+f.name+".json")

			data, err := os.ReadFile("testdata/" + f.xml + ".xml")
			if err != nil {
				t.Fatal(err)
			}
			parsed, err := feed.ParseBytes(data)
			if err != nil {
				t.Fatalf("ParseBytes: %v", err)
			}

			handle := newTestDB(t)
			// refreshFeed stores parsed.title || feed.name as the feed name.
			feedName := f.feedName
			if parsed.Title != "" {
				feedName = parsed.Title
			}
			// Fixed `now` for determinism; pub_ts/content_updated_at aren't diffed.
			if err := store.PersistItems(handle.Writer(), f.feedID, feedName, f.feedURL, parsed.Items, 1_700_000_000_000); err != nil {
				t.Fatalf("PersistItems: %v", err)
			}
			got := dumpRows(t, handle)

			if len(got) != len(want) {
				t.Fatalf("row count: got %d, want %d", len(got), len(want))
			}
			for id, w := range want {
				g, ok := got[id]
				if !ok {
					t.Errorf("missing article_id %s (id parity broken)", id)
					continue
				}
				diffRow(t, id, g, w)
			}
		})
	}
}

func diffRow(t *testing.T, id string, g, w oracleRow) {
	t.Helper()
	cmp := func(field, gv, wv string) {
		if gv != wv {
			t.Errorf("[%s] %s:\n  go=  %q\n  node=%q", id, field, gv, wv)
		}
	}
	cmp("feed_id", g.FeedID, w.FeedID)
	cmp("feed_name", g.FeedName, w.FeedName)
	cmp("feed_url", g.FeedURL, w.FeedURL)
	cmp("title", g.Title, w.Title)
	cmp("link", g.Link, w.Link)
	cmp("pub_date", g.PubDate, w.PubDate)
	cmp("summary", g.Summary, w.Summary)
	cmp("content", g.Content, w.Content)
	cmp("author", g.Author, w.Author)
	cmp("audio_url", derefStr(g.AudioURL), derefStr(w.AudioURL))
	cmp("audio_duration", derefStr(g.AudioDuration), derefStr(w.AudioDuration))
	if g.IsStarred != w.IsStarred {
		t.Errorf("[%s] is_starred: go=%d node=%d", id, g.IsStarred, w.IsStarred)
	}
}

func derefStr(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func loadOracle(t *testing.T, path string) map[string]oracleRow {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read oracle %s: %v (run gen_persist_oracle.mjs)", path, err)
	}
	var m map[string]oracleRow
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("parse oracle: %v", err)
	}
	return m
}

func newTestDB(t *testing.T) *db.DB {
	t.Helper()
	handle, err := db.OpenHandle(t.TempDir() + "/t.db")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := db.InitSchema(handle.Writer()); err != nil {
		t.Fatalf("schema: %v", err)
	}
	t.Cleanup(func() { handle.Close() })
	return handle
}

func dumpRows(t *testing.T, handle *db.DB) map[string]oracleRow {
	t.Helper()
	rows, err := handle.Reader().Query(
		`SELECT article_id,feed_id,feed_name,feed_url,title,link,pub_date,summary,content,author,audio_url,audio_duration,is_starred
		 FROM article_states`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]oracleRow{}
	for rows.Next() {
		var r oracleRow
		if err := rows.Scan(&r.ArticleID, &r.FeedID, &r.FeedName, &r.FeedURL, &r.Title,
			&r.Link, &r.PubDate, &r.Summary, &r.Content, &r.Author,
			&r.AudioURL, &r.AudioDuration, &r.IsStarred); err != nil {
			t.Fatal(err)
		}
		out[r.ArticleID] = r
	}
	return out
}
