package httpapi

import (
	"encoding/json"
	"testing"

	"rss-reader/server-go/internal/model"
	"rss-reader/server-go/internal/store"
)

// seedRuleArticle inserts one article row with the fields the collection rules match on.
func seedRuleArticle(t *testing.T, s *Server, id, feedID, title, summary string, pubTs int64) {
	t.Helper()
	_, err := s.DB.Writer().Exec(
		`INSERT INTO article_states (article_id, feed_id, feed_name, title, link, pub_date, pub_ts, summary)
		 VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
		id, feedID, "Feed "+feedID, title, "https://x/"+id, pubTs, summary)
	if err != nil {
		t.Fatalf("seedRuleArticle: %v", err)
	}
}

func collectionArticleIDs(t *testing.T, s *Server, id string) []string {
	t.Helper()
	rec := do(s.NewLocalRouter(), "GET", "/api/collections/"+id+"/articles", "", nil)
	if rec.Code != 200 {
		t.Fatalf("articles: %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Name     string          `json:"name"`
		Articles []model.Article `json:"articles"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	ids := make([]string, 0, len(body.Articles))
	for _, a := range body.Articles {
		ids = append(ids, a.ID)
	}
	return ids
}

// createCollection posts a collection and returns its id.
func createCollection(t *testing.T, s *Server, body string) string {
	t.Helper()
	rec := do(s.NewLocalRouter(), "POST", "/api/collections", body, jsonHdr())
	if rec.Code != 200 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	var c store.Collection
	if err := json.Unmarshal(rec.Body.Bytes(), &c); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if c.ID == "" {
		t.Fatal("create returned no id")
	}
	return c.ID
}

// A collection merges its rules: whole feeds and keyword-narrowed feeds together,
// newest first, with no article repeated when two rules select it.
func TestCollectionMergesRules(t *testing.T) {
	s := &Server{DB: testDB(t)}
	seedRuleArticle(t, s, "a1", "f1", "AI 模型发布", "", 500)
	seedRuleArticle(t, s, "a2", "f1", "厨房日记", "", 400)
	seedRuleArticle(t, s, "a3", "f2", "周报", "本周 AI 进展", 300)
	seedRuleArticle(t, s, "a4", "f2", "旅行", "", 200)
	seedRuleArticle(t, s, "a5", "f3", "无关文章", "", 100)

	// f1 narrowed to "AI" ∪ all of f2 ∪ a global "AI" rule (which re-selects a1/a3).
	id := createCollection(t, s, `{"name":"AI","rules":[
		{"feedId":"f1","include":"AI"},
		{"feedId":"f2"},
		{"include":"AI"}
	]}`)

	got := collectionArticleIDs(t, s, id)
	want := []string{"a1", "a3", "a4"} // a2 filtered by keyword, a5 in no rule
	if len(got) != len(want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ids = %v, want %v (newest first, deduped)", got, want)
		}
	}
}

// exclude drops matching rows, and must not drop rows whose title or summary is
// empty (NULL NOT LIKE x is NULL, which would filter them out).
func TestCollectionExcludeKeepsEmptyFields(t *testing.T) {
	s := &Server{DB: testDB(t)}
	seedRuleArticle(t, s, "b1", "f1", "赞助内容", "", 300)
	seedRuleArticle(t, s, "b2", "f1", "正常文章", "", 200)
	if _, err := s.DB.Writer().Exec(
		`INSERT INTO article_states (article_id, feed_id, title, pub_ts) VALUES ('b3','f1','裸标题',100)`,
	); err != nil {
		t.Fatalf("seed null summary: %v", err)
	}

	id := createCollection(t, s, `{"name":"去广告","rules":[{"feedId":"f1","exclude":"赞助"}]}`)
	got := collectionArticleIDs(t, s, id)
	if len(got) != 2 || got[0] != "b2" || got[1] != "b3" {
		t.Fatalf("ids = %v, want [b2 b3]", got)
	}
}

// A rule constraining nothing is a disguised full-table scan, so it is rejected
// rather than executed — and a collection whose every rule is like that is too.
func TestCollectionRejectsUnconstrainedRules(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()

	cases := []struct{ name, body string }{
		{"no name", `{"rules":[{"feedId":"f1"}]}`},
		{"blank name", `{"name":"  ","rules":[{"feedId":"f1"}]}`},
		{"no rules key", `{"name":"X"}`},
		{"empty rules", `{"name":"X","rules":[]}`},
		{"rule constrains nothing", `{"name":"X","rules":[{"exclude":"广告"}]}`},
		{"whitespace-only include", `{"name":"X","rules":[{"include":"   "}]}`},
	}
	for _, c := range cases {
		if rec := do(h, "POST", "/api/collections", c.body, jsonHdr()); rec.Code != 400 {
			t.Fatalf("%s: want 400, got %d %s", c.name, rec.Code, rec.Body.String())
		}
	}
}

// PATCH applies only what it is sent: a rename leaves the rules alone, and a
// rules-only edit leaves the name alone.
func TestCollectionPatchIsPartial(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	seedRuleArticle(t, s, "c1", "f1", "一", "", 200)
	seedRuleArticle(t, s, "c2", "f2", "二", "", 100)

	id := createCollection(t, s, `{"name":"原名","rules":[{"feedId":"f1"}]}`)

	if rec := do(h, "PATCH", "/api/collections/"+id, `{"name":"新名"}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("rename: %d %s", rec.Code, rec.Body.String())
	}
	c, ok, err := store.GetCollection(s.DB.Reader(), id)
	if err != nil || !ok {
		t.Fatalf("get after rename: %v ok=%v", err, ok)
	}
	if c.Name != "新名" || len(c.Rules) != 1 || c.Rules[0].FeedID != "f1" {
		t.Fatalf("rename clobbered rules: %+v", c)
	}

	if rec := do(h, "PATCH", "/api/collections/"+id,
		`{"rules":[{"feedId":"f2"}]}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("replace rules: %d %s", rec.Code, rec.Body.String())
	}
	c, _, _ = store.GetCollection(s.DB.Reader(), id)
	if c.Name != "新名" || len(c.Rules) != 1 || c.Rules[0].FeedID != "f2" {
		t.Fatalf("rules edit clobbered name: %+v", c)
	}
	if got := collectionArticleIDs(t, s, id); len(got) != 1 || got[0] != "c2" {
		t.Fatalf("after rule swap ids = %v, want [c2]", got)
	}

	// An invalid rule set must not land the rename that shares the request.
	if rec := do(h, "PATCH", "/api/collections/"+id,
		`{"name":"不该生效","rules":[{"exclude":"x"}]}`, jsonHdr()); rec.Code != 400 {
		t.Fatalf("bad rules: want 400, got %d", rec.Code)
	}
	c, _, _ = store.GetCollection(s.DB.Reader(), id)
	if c.Name != "新名" {
		t.Fatalf("rejected PATCH still renamed: %+v", c)
	}
}

// Deleting a collection removes it and its rules — and no articles.
func TestCollectionDeleteKeepsArticles(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()
	seedRuleArticle(t, s, "d1", "f1", "留下", "", 100)

	id := createCollection(t, s, `{"name":"临时","rules":[{"feedId":"f1"}]}`)
	if rec := do(h, "DELETE", "/api/collections/"+id, "", nil); rec.Code != 200 {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(h, "DELETE", "/api/collections/"+id, "", nil); rec.Code != 404 {
		t.Fatalf("re-delete: want 404, got %d", rec.Code)
	}
	if rec := do(h, "GET", "/api/collections/"+id+"/articles", "", nil); rec.Code != 404 {
		t.Fatalf("articles after delete: want 404, got %d", rec.Code)
	}

	var rules, arts int
	_ = s.DB.Reader().QueryRow(`SELECT COUNT(*) FROM collection_rules`).Scan(&rules)
	_ = s.DB.Reader().QueryRow(`SELECT COUNT(*) FROM article_states`).Scan(&arts)
	if rules != 0 {
		t.Fatalf("rules left behind: %d", rules)
	}
	if arts != 1 {
		t.Fatalf("delete touched articles: %d rows left, want 1", arts)
	}
}

// GET /api/collections returns each collection with its rules attached.
func TestListCollections(t *testing.T) {
	s := &Server{DB: testDB(t)}
	h := s.NewLocalRouter()

	rec := do(h, "GET", "/api/collections", "", nil)
	if rec.Code != 200 || rec.Body.String() != "[]\n" {
		t.Fatalf("empty list: %d %q", rec.Code, rec.Body.String())
	}

	createCollection(t, s, `{"name":"甲","rules":[{"feedId":"f1"},{"include":"AI"}]}`)
	createCollection(t, s, `{"name":"乙","rules":[{"feedId":"f2","exclude":"广告"}]}`)

	rec = do(h, "GET", "/api/collections", "", nil)
	var got []store.Collection
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 2 || got[0].Name != "甲" || got[1].Name != "乙" {
		t.Fatalf("list = %+v", got)
	}
	if len(got[0].Rules) != 2 || got[0].Rules[1].Include != "AI" {
		t.Fatalf("rules of 甲 = %+v", got[0].Rules)
	}
	if len(got[1].Rules) != 1 || got[1].Rules[0].Exclude != "广告" {
		t.Fatalf("rules of 乙 = %+v", got[1].Rules)
	}
}

// A keyword containing LIKE metacharacters matches literally, not as a wildcard.
func TestCollectionKeywordEscapesLikeWildcards(t *testing.T) {
	s := &Server{DB: testDB(t)}
	seedRuleArticle(t, s, "e1", "f1", "100% 纯净", "", 200)
	seedRuleArticle(t, s, "e2", "f1", "毫不相关", "", 100)

	id := createCollection(t, s, `{"name":"字面量","rules":[{"feedId":"f1","include":"100%"}]}`)
	if got := collectionArticleIDs(t, s, id); len(got) != 1 || got[0] != "e1" {
		t.Fatalf("ids = %v, want [e1]", got)
	}
}
