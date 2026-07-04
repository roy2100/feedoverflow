package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// recordedRequest captures one call the mcp tool made into the loopback API.
type recordedRequest struct {
	method string
	path   string
	body   string
}

// testServerAndAPI starts NewServer(port) pointed at a stub loopback API, and
// returns a connected client session plus the requests the stub observed.
func testServerAndAPI(t *testing.T, api http.HandlerFunc) (*sdkmcp.ClientSession, *[]recordedRequest) {
	t.Helper()
	var got []recordedRequest
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := make([]byte, r.ContentLength)
		if r.ContentLength > 0 {
			r.Body.Read(b)
		}
		got = append(got, recordedRequest{method: r.Method, path: r.URL.RequestURI(), body: string(b)})
		api(w, r)
	}))
	t.Cleanup(stub.Close)
	host := strings.TrimPrefix(stub.URL, "http://127.0.0.1:")
	port, err := strconv.Atoi(host)
	if err != nil {
		t.Fatalf("parse port from %q: %v", stub.URL, err)
	}

	server := NewServer(port)
	t1, t2 := sdkmcp.NewInMemoryTransports()
	ctx := context.Background()
	if _, err := server.Connect(ctx, t1, nil); err != nil {
		t.Fatalf("server connect: %v", err)
	}
	client := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "test-client", Version: "v0"}, nil)
	session, err := client.Connect(ctx, t2, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	t.Cleanup(func() { session.Close() })
	return session, &got
}

// callTool invokes a tool and fails the test on an MCP-level or tool-level error.
func callTool(t *testing.T, session *sdkmcp.ClientSession, name string, args map[string]any) string {
	t.Helper()
	res, err := session.CallTool(context.Background(), &sdkmcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("CallTool(%s): %v", name, err)
	}
	if res.IsError {
		t.Fatalf("CallTool(%s) returned tool error: %v", name, res.Content)
	}
	if len(res.Content) != 1 {
		t.Fatalf("CallTool(%s): want 1 content block, got %d", name, len(res.Content))
	}
	text, ok := res.Content[0].(*sdkmcp.TextContent)
	if !ok {
		t.Fatalf("CallTool(%s): want TextContent, got %T", name, res.Content[0])
	}
	return text.Text
}

func jsonOK(v string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(v))
	}
}

func TestListFeeds(t *testing.T) {
	session, got := testServerAndAPI(t, jsonOK(`[{"id":"1","name":"HN"}]`))
	out := callTool(t, session, "list_feeds", nil)
	if !strings.Contains(out, `"name": "HN"`) {
		t.Errorf("want output to contain feed name, got %q", out)
	}
	if len(*got) != 1 || (*got)[0].method != "GET" || (*got)[0].path != "/api/feeds" {
		t.Errorf("want single GET /api/feeds, got %#v", *got)
	}
}

func TestAddFeed(t *testing.T) {
	session, got := testServerAndAPI(t, jsonOK(`{"id":"2","name":"Blog"}`))
	callTool(t, session, "add_feed", map[string]any{"url": "https://blog.example/rss", "name": "Blog"})
	if len(*got) != 1 || (*got)[0].method != "POST" || (*got)[0].path != "/api/feeds" {
		t.Fatalf("want single POST /api/feeds, got %#v", *got)
	}
	var body map[string]any
	json.Unmarshal([]byte((*got)[0].body), &body)
	if body["url"] != "https://blog.example/rss" || body["name"] != "Blog" {
		t.Errorf("want url+name forwarded, got %#v", body)
	}
}

func TestRenameFeedEscapesID(t *testing.T) {
	session, got := testServerAndAPI(t, jsonOK(`{"ok":true}`))
	callTool(t, session, "rename_feed", map[string]any{"id": "a/b", "name": "New"})
	if len(*got) != 1 || (*got)[0].method != "PATCH" || (*got)[0].path != "/api/feeds/a%2Fb" {
		t.Fatalf("want PATCH /api/feeds/a%%2Fb, got %#v", *got)
	}
}

func TestDeleteFeed(t *testing.T) {
	session, got := testServerAndAPI(t, jsonOK(`{"ok":true}`))
	callTool(t, session, "delete_feed", map[string]any{"id": "1"})
	if len(*got) != 1 || (*got)[0].method != "DELETE" || (*got)[0].path != "/api/feeds/1" {
		t.Fatalf("want DELETE /api/feeds/1, got %#v", *got)
	}
}

func TestImportOPML(t *testing.T) {
	session, got := testServerAndAPI(t, jsonOK(`{"imported":1,"skipped":0}`))
	callTool(t, session, "import_opml", map[string]any{"opml": "<opml></opml>"})
	if len(*got) != 1 || (*got)[0].method != "POST" || (*got)[0].path != "/api/feeds/import-opml" {
		t.Fatalf("want POST /api/feeds/import-opml, got %#v", *got)
	}
}

func TestGetAllArticles(t *testing.T) {
	session, got := testServerAndAPI(t, jsonOK(`[]`))
	callTool(t, session, "get_all_articles", nil)
	if len(*got) != 1 || (*got)[0].path != "/api/all-articles" {
		t.Fatalf("want GET /api/all-articles, got %#v", *got)
	}
}

func TestGetTodayArticles(t *testing.T) {
	session, got := testServerAndAPI(t, jsonOK(`[]`))
	callTool(t, session, "get_today_articles", nil)
	if len(*got) != 1 || (*got)[0].path != "/api/today" {
		t.Fatalf("want GET /api/today, got %#v", *got)
	}
}

func TestGetStarredArticles(t *testing.T) {
	session, got := testServerAndAPI(t, jsonOK(`[]`))
	callTool(t, session, "get_starred_articles", nil)
	if len(*got) != 1 || (*got)[0].path != "/api/starred" {
		t.Fatalf("want GET /api/starred, got %#v", *got)
	}
}

func TestGetFeedArticles(t *testing.T) {
	session, got := testServerAndAPI(t, jsonOK(`[]`))
	callTool(t, session, "get_feed_articles", map[string]any{"feed_id": "1"})
	if len(*got) != 1 || (*got)[0].path != "/api/feeds/1/articles" {
		t.Fatalf("want GET /api/feeds/1/articles, got %#v", *got)
	}
}

func TestGetStarredCount(t *testing.T) {
	session, got := testServerAndAPI(t, jsonOK(`{"count":3}`))
	out := callTool(t, session, "get_starred_count", nil)
	if !strings.Contains(out, "3") {
		t.Errorf("want count 3 in output, got %q", out)
	}
	if len(*got) != 1 || (*got)[0].path != "/api/starred/count" {
		t.Fatalf("want GET /api/starred/count, got %#v", *got)
	}
}

func TestToggleStar(t *testing.T) {
	session, got := testServerAndAPI(t, jsonOK(`{"ok":true}`))
	callTool(t, session, "toggle_star", map[string]any{
		"id": "abc", "feedId": "1", "feedName": "HN", "title": "T",
		"link": "https://x/1", "pubDate": "2026-01-01", "starred": true,
	})
	if len(*got) != 1 || (*got)[0].method != "POST" || (*got)[0].path != "/api/articles/star" {
		t.Fatalf("want POST /api/articles/star, got %#v", *got)
	}
	var body map[string]any
	json.Unmarshal([]byte((*got)[0].body), &body)
	if body["starred"] != true {
		t.Errorf("want starred=true forwarded, got %#v", body)
	}
	article, ok := body["article"].(map[string]any)
	if !ok || article["id"] != "abc" || article["feedId"] != "1" {
		t.Errorf("want article payload forwarded, got %#v", body["article"])
	}
}

func TestGetCurrentArticle(t *testing.T) {
	session, got := testServerAndAPI(t, jsonOK(`{"title":"Now Reading"}`))
	callTool(t, session, "get_current_article", nil)
	if len(*got) != 1 || (*got)[0].path != "/api/current-article" {
		t.Fatalf("want GET /api/current-article, got %#v", *got)
	}
}

func TestFetchArticleContent(t *testing.T) {
	session, got := testServerAndAPI(t, jsonOK(`{"content":"..."}`))
	callTool(t, session, "fetch_article_content", map[string]any{"url": "https://x/a?b=c&d=e"})
	if len(*got) != 1 || (*got)[0].method != "GET" {
		t.Fatalf("want single GET, got %#v", *got)
	}
	if (*got)[0].path != "/api/fetch-content?url=https%3A%2F%2Fx%2Fa%3Fb%3Dc%26d%3De" {
		t.Fatalf("want URL-escaped query, got %q", (*got)[0].path)
	}
}

func TestToolErrorSurfacesAsToolFailure(t *testing.T) {
	session, _ := testServerAndAPI(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`url is required`))
	})
	res, err := session.CallTool(context.Background(), &sdkmcp.CallToolParams{Name: "list_feeds"})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if !res.IsError {
		t.Fatalf("want IsError=true when the loopback API fails, got %#v", res)
	}
}
