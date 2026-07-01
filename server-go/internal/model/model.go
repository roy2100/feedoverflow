// Package model holds the API-facing shapes, the Go mirror of server/types.ts.
// JSON tags match the wire contract exactly (camelCase Article fields, snake_case
// raw feed rows) so responses are byte-comparable with the Node build.
package model

// Feed is a raw feeds row as returned by GET /api/feeds. The dead `category`
// column present in the production DB is intentionally omitted (see db.go).
type Feed struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	URL           string `json:"url"`
	LastFetchedAt *int64 `json:"last_fetched_at"`
}

// Article is the enriched article shape returned by the list/detail endpoints.
// UpdatedAt is nil (JSON null) until the article was edited upstream.
type Article struct {
	ID            string `json:"id"`
	FeedID        string `json:"feedId"`
	FeedName      string `json:"feedName"`
	Title         string `json:"title"`
	Summary       string `json:"summary"`
	Content       string `json:"content"`
	Link          string `json:"link"`
	PubDate       string `json:"pubDate"`
	Author        string `json:"author"`
	AudioURL      string `json:"audioUrl"`
	AudioDuration string `json:"audioDuration"`
	IsStarred     bool   `json:"isStarred"`
	UpdatedAt     *int64 `json:"updatedAt"`
}
