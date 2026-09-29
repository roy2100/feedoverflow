package httpapi

import (
	"encoding/json"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"
)

type trendResp struct {
	Query    string        `json:"query"`
	Days     int           `json:"days"`
	Matched  int           `json:"matched"`
	Buckets  []trendBucket `json:"buckets"`
	Articles []struct {
		ID      string `json:"id"`
		Summary string `json:"summary"`
		Content string `json:"content"`
	} `json:"articles"`
}

func getTrendResp(t *testing.T, s *Server, target string) trendResp {
	t.Helper()
	rec := do(s.NewLocalRouter(), "GET", target, "", nil)
	if rec.Code != 200 {
		t.Fatalf("GET %s: %d %s", target, rec.Code, rec.Body.String())
	}
	var body trendResp
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return body
}

func trendIDs(b trendResp) []string {
	ids := make([]string, 0, len(b.Articles))
	for _, a := range b.Articles {
		ids = append(ids, a.ID)
	}
	return ids
}

// localMidnight is the start of the local day `back` days before today, in ms.
func localMidnight(back int) int64 {
	now := time.Now()
	return time.Date(now.Year(), now.Month(), now.Day()-back, 0, 0, 0, 0, now.Location()).UnixMilli()
}

// A Latin term matches whole words in title or summary: museum/amused don't count,
// a CJK neighbour (版Muse) is a word boundary, and the body is never looked at.
func TestTrendWordBoundary(t *testing.T) {
	s := &Server{DB: testDB(t)}
	at := localMidnight(0) + 1
	seedRuleArticle(t, s, "m1", "f1", "Meta Muse 上线", "", at)
	seedRuleArticle(t, s, "m2", "f1", "字节版Muse要来了", "", at)
	seedRuleArticle(t, s, "m3", "f1", "周报", "about MUSE today", at)
	seedRuleArticle(t, s, "x1", "f1", "Museum reopens", "", at)
	seedRuleArticle(t, s, "x2", "f1", "Amused", "", at)
	seedRuleArticle(t, s, "x3", "f1", "无关", "", at)
	if _, err := s.DB.Writer().Exec(
		`UPDATE article_states SET content = '<img alt="Muse app">' WHERE article_id = 'x3'`); err != nil {
		t.Fatal(err)
	}

	b := getTrendResp(t, s, "/api/trend?q=muse&days=7")
	if b.Matched != 3 || len(b.Articles) != 3 {
		t.Fatalf("matched = %d, ids = %v; want m1,m2,m3", b.Matched, trendIDs(b))
	}
	for _, id := range trendIDs(b) {
		if strings.HasPrefix(id, "x") {
			t.Errorf("%s must not match", id)
		}
	}
}

// Buckets are dense local days ending today; counts land on the right day, the
// window starts at local midnight, and a future-dated row is left out.
func TestTrendBuckets(t *testing.T) {
	s := &Server{DB: testDB(t)}
	seedRuleArticle(t, s, "today", "f1", "Muse", "", localMidnight(0)+1)
	seedRuleArticle(t, s, "d2a", "f1", "Muse", "", localMidnight(2)+1000)
	seedRuleArticle(t, s, "d2b", "f1", "Muse", "", localMidnight(2)+2000)
	seedRuleArticle(t, s, "other", "f1", "别的新闻", "", localMidnight(2)+3000)
	seedRuleArticle(t, s, "edge", "f1", "Muse", "", localMidnight(6))     // first instant of the window
	seedRuleArticle(t, s, "before", "f1", "Muse", "", localMidnight(6)-1) // one ms too early
	seedRuleArticle(t, s, "future", "f1", "Muse", "", time.Now().Add(time.Hour).UnixMilli())

	b := getTrendResp(t, s, "/api/trend?q=Muse&days=7")
	if len(b.Buckets) != 7 {
		t.Fatalf("buckets = %d, want 7", len(b.Buckets))
	}
	if want := time.Now().Format(time.DateOnly); b.Buckets[6].Date != want {
		t.Errorf("last bucket = %s, want today %s", b.Buckets[6].Date, want)
	}
	counts := make([]int, 7)
	for i, bk := range b.Buckets {
		counts[i] = bk.Count
	}
	if want := []int{1, 0, 0, 0, 2, 0, 1}; !slices.Equal(counts, want) {
		t.Errorf("counts = %v, want %v", counts, want)
	}
	if b.Buckets[4].Total != 3 {
		t.Errorf("day-2 total = %d, want 3 (two matches + one other)", b.Buckets[4].Total)
	}
	if b.Matched != 4 {
		t.Errorf("matched = %d, want 4", b.Matched)
	}
	if got := trendIDs(b); len(got) != 4 || got[0] != "today" || got[3] != "edge" {
		t.Errorf("ids = %v, want newest first from today to edge", got)
	}
}

// `|` ORs synonyms into one series, counting an article once when both match.
func TestTrendSynonyms(t *testing.T) {
	s := &Server{DB: testDB(t)}
	at := localMidnight(0) + 1
	seedRuleArticle(t, s, "en", "f1", "Nvidia earnings", "", at+1)
	seedRuleArticle(t, s, "zh", "f1", "英伟达财报", "", at+2)
	seedRuleArticle(t, s, "both", "f1", "英伟达 Nvidia", "", at+3)

	b := getTrendResp(t, s, "/api/trend?q="+url.QueryEscape("英伟达 | Nvidia |")+"&days=7")
	if b.Matched != 3 {
		t.Fatalf("matched = %d, want 3", b.Matched)
	}
	if got := trendIDs(b); !slices.Equal(got, []string{"both", "zh", "en"}) {
		t.Errorf("ids = %v, want newest first across terms", got)
	}
}

// `day` and `limit` narrow the article list only; bars and `matched` stay whole.
// The list never carries summary or content.
func TestTrendDayAndLimit(t *testing.T) {
	s := &Server{DB: testDB(t)}
	seedRuleArticle(t, s, "t1", "f1", "Muse", "Muse summary", localMidnight(0)+1)
	seedRuleArticle(t, s, "t2", "f1", "Muse", "", localMidnight(0)+2)
	seedRuleArticle(t, s, "y1", "f1", "Muse", "", localMidnight(1)+1)

	yesterday := time.UnixMilli(localMidnight(1)).Format(time.DateOnly)
	b := getTrendResp(t, s, "/api/trend?q=Muse&days=7&day="+yesterday)
	if !slices.Equal(trendIDs(b), []string{"y1"}) || b.Matched != 3 {
		t.Errorf("day filter: ids = %v matched = %d, want [y1] and 3", trendIDs(b), b.Matched)
	}

	b = getTrendResp(t, s, "/api/trend?q=Muse&days=7&limit=1")
	if !slices.Equal(trendIDs(b), []string{"t2"}) || b.Matched != 3 {
		t.Errorf("limit: ids = %v matched = %d, want [t2] and 3", trendIDs(b), b.Matched)
	}
	for _, a := range b.Articles {
		if a.Summary != "" || a.Content != "" {
			t.Errorf("article %s carries summary/content", a.ID)
		}
	}
}

func TestTrendDefaultsAndValidation(t *testing.T) {
	s := &Server{DB: testDB(t)}
	if b := getTrendResp(t, s, "/api/trend?q=Muse"); b.Days != 30 || len(b.Buckets) != 30 {
		t.Errorf("default days = %d / %d buckets, want 30", b.Days, len(b.Buckets))
	}
	outside := time.UnixMilli(localMidnight(10)).Format(time.DateOnly)
	for _, target := range []string{
		"/api/trend",
		"/api/trend?q=%20|%20",
		"/api/trend?q=a|b|c|d|e|f",
		"/api/trend?q=Muse&days=14",
		"/api/trend?q=Muse&days=x",
		"/api/trend?q=Muse&limit=0",
		"/api/trend?q=Muse&limit=501",
		"/api/trend?q=Muse&days=7&day=" + outside,
	} {
		if rec := do(s.NewLocalRouter(), "GET", target, "", nil); rec.Code != 400 {
			t.Errorf("GET %s = %d, want 400", target, rec.Code)
		}
	}
}
