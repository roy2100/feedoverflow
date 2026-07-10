package mcp

import (
	"context"
	"encoding/json"
	"net/url"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// textResult wraps an arbitrary JSON-able value as a single text content block,
// matching server/mcp.ts's text() helper (JSON.stringify(data, null, 2)).
func textResult(v any) (*mcp.CallToolResult, any, error) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(b)}}}, nil, nil
}

// NewServer builds the FeedOverflow MCP server: the same 13 tools as the Node
// original (server/mcp.ts, legacy_server_node branch), each a thin call into
// the loopback API at 127.0.0.1:port.
func NewServer(port int) *mcp.Server {
	c := newClient(port)
	server := mcp.NewServer(&mcp.Implementation{Name: "feedoverflow", Version: "1.0.0"}, nil)

	// --- Feeds ---

	mcp.AddTool(server, &mcp.Tool{
		Name:        "list_feeds",
		Description: "List all subscribed RSS feeds with their id, name, and URL.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ any) (*mcp.CallToolResult, any, error) {
		res, err := c.get(ctx, "/api/feeds")
		if err != nil {
			return nil, nil, err
		}
		return textResult(res)
	})

	type addFeedInput struct {
		URL  string `json:"url" jsonschema:"RSS feed URL"`
		Name string `json:"name,omitempty" jsonschema:"Display name; defaults to feed title if omitted"`
	}
	mcp.AddTool(server, &mcp.Tool{
		Name:        "add_feed",
		Description: "Subscribe to a new RSS feed by URL.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in addFeedInput) (*mcp.CallToolResult, any, error) {
		res, err := c.post(ctx, "/api/feeds", map[string]any{"url": in.URL, "name": in.Name})
		if err != nil {
			return nil, nil, err
		}
		return textResult(res)
	})

	type renameFeedInput struct {
		ID   string `json:"id" jsonschema:"Feed ID from list_feeds"`
		Name string `json:"name" jsonschema:"New display name"`
	}
	mcp.AddTool(server, &mcp.Tool{
		Name:        "rename_feed",
		Description: "Rename an existing feed.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in renameFeedInput) (*mcp.CallToolResult, any, error) {
		res, err := c.patch(ctx, "/api/feeds/"+url.PathEscape(in.ID), map[string]any{"name": in.Name})
		if err != nil {
			return nil, nil, err
		}
		return textResult(res)
	})

	type feedIDInput struct {
		ID string `json:"id" jsonschema:"Feed ID from list_feeds"`
	}
	mcp.AddTool(server, &mcp.Tool{
		Name:        "delete_feed",
		Description: "Unsubscribe from a feed and remove it from the list.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in feedIDInput) (*mcp.CallToolResult, any, error) {
		res, err := c.delete(ctx, "/api/feeds/"+url.PathEscape(in.ID))
		if err != nil {
			return nil, nil, err
		}
		return textResult(res)
	})

	type importOPMLInput struct {
		OPML string `json:"opml" jsonschema:"OPML XML content as a string"`
	}
	mcp.AddTool(server, &mcp.Tool{
		Name:        "import_opml",
		Description: "Bulk-import feeds from an OPML XML string. Returns count of imported and skipped feeds.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in importOPMLInput) (*mcp.CallToolResult, any, error) {
		res, err := c.post(ctx, "/api/feeds/import-opml", map[string]any{"opml": in.OPML})
		if err != nil {
			return nil, nil, err
		}
		return textResult(res)
	})

	// --- Articles ---

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_all_articles",
		Description: "Get the latest articles across all feeds (up to 5 per feed), sorted by date descending.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ any) (*mcp.CallToolResult, any, error) {
		res, err := c.get(ctx, "/api/all-articles")
		if err != nil {
			return nil, nil, err
		}
		return textResult(res)
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_today_articles",
		Description: "Get all articles published today across all feeds.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ any) (*mcp.CallToolResult, any, error) {
		res, err := c.get(ctx, "/api/today")
		if err != nil {
			return nil, nil, err
		}
		return textResult(res)
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_starred_articles",
		Description: "Get all starred/bookmarked articles.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ any) (*mcp.CallToolResult, any, error) {
		res, err := c.get(ctx, "/api/starred")
		if err != nil {
			return nil, nil, err
		}
		return textResult(res)
	})

	type feedArticlesInput struct {
		FeedID string `json:"feed_id" jsonschema:"Feed ID from list_feeds"`
	}
	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_feed_articles",
		Description: "Get the latest articles (up to 50) from a specific feed.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in feedArticlesInput) (*mcp.CallToolResult, any, error) {
		res, err := c.get(ctx, "/api/feeds/"+url.PathEscape(in.FeedID)+"/articles")
		if err != nil {
			return nil, nil, err
		}
		return textResult(res)
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_starred_count",
		Description: "Get the total count of starred articles.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ any) (*mcp.CallToolResult, any, error) {
		res, err := c.get(ctx, "/api/starred/count")
		if err != nil {
			return nil, nil, err
		}
		return textResult(res)
	})

	// --- Article state ---

	type toggleStarInput struct {
		ID        string `json:"id" jsonschema:"Article ID (12-char MD5 hash)"`
		FeedID    string `json:"feedId" jsonschema:"Feed ID the article belongs to"`
		FeedName  string `json:"feedName" jsonschema:"Display name of the feed"`
		Title     string `json:"title" jsonschema:"Article title"`
		Link      string `json:"link" jsonschema:"Article URL"`
		PubDate   string `json:"pubDate" jsonschema:"Publication date in ISO format"`
		Summary   string `json:"summary,omitempty" jsonschema:"Article summary/snippet"`
		Content   string `json:"content,omitempty" jsonschema:"Full article HTML content"`
		Author    string `json:"author,omitempty" jsonschema:"Article author"`
		IsStarred bool   `json:"isStarred,omitempty" jsonschema:"Current starred state, if known"`
		Starred   bool   `json:"starred" jsonschema:"true to star, false to unstar"`
	}
	mcp.AddTool(server, &mcp.Tool{
		Name:        "toggle_star",
		Description: "Star or unstar an article. Pass the full article object and the desired starred state.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in toggleStarInput) (*mcp.CallToolResult, any, error) {
		article := map[string]any{
			"id": in.ID, "feedId": in.FeedID, "feedName": in.FeedName, "title": in.Title,
			"link": in.Link, "pubDate": in.PubDate, "summary": in.Summary, "content": in.Content,
			"author": in.Author, "isStarred": in.IsStarred,
		}
		res, err := c.post(ctx, "/api/articles/star", map[string]any{"article": article, "starred": in.Starred})
		if err != nil {
			return nil, nil, err
		}
		return textResult(res)
	})

	// --- Current article ---

	mcp.AddTool(server, &mcp.Tool{
		Name: "get_current_article",
		Description: "Get the article currently open in the RSS reader UI. Returns the full article object " +
			"including title, link, summary, content, author, feed name, and starred state. Use this when the " +
			"user says 'this article', 'the current article', or 'what I'm reading'.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ any) (*mcp.CallToolResult, any, error) {
		res, err := c.get(ctx, "/api/current-article")
		if err != nil {
			return nil, nil, err
		}
		return textResult(res)
	})

	// --- Content ---

	type fetchContentInput struct {
		URL string `json:"url" jsonschema:"Article URL"`
	}
	mcp.AddTool(server, &mcp.Tool{
		Name: "fetch_article_content",
		Description: "Fetch the full readable content of an article from its original URL using Mozilla " +
			"Readability. Use when the article summary is truncated.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in fetchContentInput) (*mcp.CallToolResult, any, error) {
		res, err := c.get(ctx, "/api/fetch-content?url="+url.QueryEscape(in.URL))
		if err != nil {
			return nil, nil, err
		}
		return textResult(res)
	})

	return server
}
