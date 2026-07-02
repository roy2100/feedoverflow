// Package feed is the Go port of server/parse-url.ts: fetch a feed URL (or bytes)
// and map each entry to the exact field shape the Node persist chain produces.
//
// Field-mapping parity with rss-parser is the load-bearing concern (see
// docs/plan-go-backend-migration.md Phase 6). The rules below reproduce
// rss-parser's parseItemRss/parseItemAtom + utils.getSnippet precisely; the
// gofeed translator's own defaults differ (author priority, atom ISO dates,
// snippet source), so we bypass them and derive fields ourselves:
//
//	content  = firstNonEmpty(gofeed.Content /*content:encoded / atom content*/,
//	           gofeed.Description /*rss description / atom summary*/)
//	summary  = getSnippet(base) || rawSummary, where base is atom→Content,
//	           rss→Description (rss-parser's contentSnippet source), and
//	           getSnippet = trim(unescapeHTML(stripHtml(x)))
//	pubDate  = rss→raw <pubDate>; atom→new Date(published||updated).toISOString()
//	author   = dc:creator || author-name (dc:creator wins, matching Node's
//	           `item.creator || item.author`; gofeed defaults the other way)
package feed

import (
	"bytes"
	"context"
	"fmt"
	"html"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/mmcdole/gofeed"

	"rss-reader/server-go/internal/dates"
)

// Item is one parsed entry, already reduced to the fields persistItems needs.
type Item struct {
	Link           string
	Title          string
	PubDate        string
	Content        string
	Summary        string
	Author         string
	EnclosureURL   string
	EnclosureType  string
	ItunesDuration string
}

// Parsed is a parsed feed: its title plus the mapped items.
type Parsed struct {
	Title string
	Items []Item
}

const fetchTimeout = 10 * time.Second

// stripHtml / getSnippet mirror utils.stripHtml + utils.getSnippet in rss-parser:
// first insert a newline around block-level tags, then strip every tag, then
// decode HTML entities and trim. The regexes match rss-parser's verbatim (JS
// `(?:.|\n)` → Go `[\s\S]`).
var (
	reBlockTag = regexp.MustCompile(`([^\n])</?(h|br|p|ul|ol|li|blockquote|section|table|tr|div)[\s\S]*?>([^\n])`)
	reAnyTag   = regexp.MustCompile(`<[\s\S]*?>`)
)

func stripHTML(s string) string {
	s = reBlockTag.ReplaceAllString(s, "${1}\n${3}")
	s = reAnyTag.ReplaceAllString(s, "")
	return s
}

func getSnippet(s string) string {
	return strings.TrimSpace(html.UnescapeString(stripHTML(s)))
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// mapItem reduces one gofeed item to our Item, applying the parity rules above.
func mapItem(gi *gofeed.Item, atom bool) Item {
	content := firstNonEmpty(gi.Content, gi.Description)

	// contentSnippet source: atom snippets its <content>, rss its <description>.
	snipBase := gi.Description
	if atom {
		snipBase = gi.Content
	}
	summary := getSnippet(snipBase)
	if summary == "" && atom {
		// Node: contentSnippet || item.summary — atom's raw <summary> is the fallback.
		summary = gi.Description
	}

	pubDate := gi.Published
	if atom {
		// rss-parser: new Date(published||updated).toISOString(). gofeed's
		// PublishedParsed already falls back published→updated.
		pubDate = ""
		if gi.PublishedParsed != nil {
			pubDate = dates.ISOString(gi.PublishedParsed.UnixMilli())
		}
	}

	author := ""
	if gi.DublinCoreExt != nil && len(gi.DublinCoreExt.Creator) > 0 {
		author = gi.DublinCoreExt.Creator[0]
	}
	if author == "" && len(gi.Authors) > 0 && gi.Authors[0] != nil {
		author = gi.Authors[0].Name
	}

	encURL, encType := "", ""
	if len(gi.Enclosures) > 0 && gi.Enclosures[0] != nil {
		encURL = gi.Enclosures[0].URL
		encType = gi.Enclosures[0].Type
	}
	dur := ""
	if gi.ITunesExt != nil {
		dur = gi.ITunesExt.Duration
	}

	return Item{
		Link:           gi.Link,
		Title:          gi.Title,
		PubDate:        pubDate,
		Content:        content,
		Summary:        summary,
		Author:         author,
		EnclosureURL:   encURL,
		EnclosureType:  encType,
		ItunesDuration: dur,
	}
}

// ParseBytes parses feed XML/JSON bytes and maps every item.
func ParseBytes(data []byte) (*Parsed, error) {
	fp := gofeed.NewParser()
	f, err := fp.Parse(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	atom := f.FeedType == "atom"
	items := make([]Item, 0, len(f.Items))
	for _, gi := range f.Items {
		items = append(items, mapItem(gi, atom))
	}
	return &Parsed{Title: f.Title, Items: items}, nil
}

// ParseURL fetches a feed (trailing slash stripped, like parse-url.ts) with a
// hard 10s timeout and the RSS-Reader user-agent, then parses the bytes.
func ParseURL(ctx context.Context, url string) (*Parsed, error) {
	target := strings.TrimSuffix(url, "/")
	data, err := fetchXML(ctx, target)
	if err != nil {
		return nil, err
	}
	return ParseBytes(data)
}

func fetchXML(ctx context.Context, url string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "RSS-Reader/1.0")
	req.Header.Set("Accept", "*/*")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("Status code %d", res.StatusCode)
	}
	return io.ReadAll(res.Body)
}
