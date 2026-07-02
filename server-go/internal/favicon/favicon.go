// Package favicon is the Go port of server/favicon.ts: a read-through favicon
// cache backed by favicon_cache (BLOB), fetching from Google's s2 service on a
// miss. Successful icons are cached 30 days; failures are stored as a NULL-image
// negative row and retried after 1 day. A nil result means "no icon" — the caller
// serves DefaultFavicon (a placeholder <Rss> SVG) so the browser logs no error.
package favicon

import (
	"context"
	"database/sql"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"rss-reader/server-go/internal/db"
)

const (
	positiveTTL = 30 * 24 * 60 * 60 * 1000 // 30 days (ms)
	negativeTTL = 24 * 60 * 60 * 1000      // 1 day (ms)
)

// DomainRE is the conservative hostname check from favicon.ts: dot-separated
// letter/digit/hyphen labels. The total-length 1..253 bound (Node's `(?=.{1,253}$)`
// lookahead, unsupported by Go's RE2) is enforced separately in validDomain.
var DomainRE = regexp.MustCompile(`^(?i)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$`)

// validDomain reproduces the full DOMAIN_RE check including the length bound.
func validDomain(domain string) bool {
	if len(domain) < 1 || len(domain) > 253 {
		return false
	}
	return DomainRE.MatchString(domain)
}

// DefaultFavicon is the placeholder served when no icon is available — the lucide
// <Rss> glyph in --text-tertiary, byte-identical to favicon.ts's DEFAULT_FAVICON.
var DefaultFavicon = []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ` +
	`fill="none" stroke="#78716C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
	`<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>`)

// DefaultContentType is the placeholder's MIME type.
const DefaultContentType = "image/svg+xml"

// Result is a resolved favicon: the raw bytes plus its content type.
type Result struct {
	Image       []byte
	ContentType string
}

// FetchFunc fetches a domain's favicon from upstream. Injectable so tests avoid
// the network; nil → the real Google s2 fetch.
type FetchFunc func(ctx context.Context, domain string) (image []byte, contentType string, err error)

// Cache is the favicon read-through cache over the DB pools.
type Cache struct {
	db    *db.DB
	fetch FetchFunc
	now   func() int64 // clock (ms); overridable in tests
}

// New builds a Cache. Pass nil fetch to use the real Google s2 fetch.
func New(handle *db.DB, fetch FetchFunc) *Cache {
	if fetch == nil {
		fetch = fetchFromGoogle
	}
	return &Cache{db: handle, fetch: fetch, now: func() int64 { return time.Now().UnixMilli() }}
}

// Get returns the cached favicon for a domain, fetching + persisting on a miss.
// A nil result (no error) means "no icon available" — serve the placeholder.
func (c *Cache) Get(ctx context.Context, domain string) (*Result, error) {
	if !validDomain(domain) {
		return nil, nil
	}

	image, ctype, fetchedAt, found, err := c.read(domain)
	if err != nil {
		return nil, err
	}
	if found {
		var fresh bool
		if image != nil {
			fresh = c.now()-fetchedAt < positiveTTL
		} else {
			fresh = c.now()-fetchedAt < negativeTTL
		}
		if fresh {
			if image != nil {
				if ctype == "" {
					ctype = "image/png"
				}
				return &Result{Image: image, ContentType: ctype}, nil
			}
			return nil, nil // fresh negative cache
		}
	}

	img, contentType, ferr := c.fetch(ctx, domain)
	if ferr != nil || len(img) == 0 {
		if werr := c.put(domain, nil, "", c.now()); werr != nil { // negative cache
			return nil, werr
		}
		return nil, nil
	}
	if contentType == "" {
		contentType = "image/png"
	}
	if werr := c.put(domain, img, contentType, c.now()); werr != nil {
		return nil, werr
	}
	return &Result{Image: img, ContentType: contentType}, nil
}

func (c *Cache) read(domain string) (image []byte, ctype string, fetchedAt int64, found bool, err error) {
	var img []byte
	var ct sql.NullString
	var fa sql.NullInt64
	row := c.db.Reader().QueryRow(
		`SELECT image, content_type, fetched_at FROM favicon_cache WHERE domain = ?`, domain)
	switch e := row.Scan(&img, &ct, &fa); e {
	case sql.ErrNoRows:
		return nil, "", 0, false, nil
	case nil:
		return img, ct.String, fa.Int64, true, nil
	default:
		return nil, "", 0, false, e
	}
}

func (c *Cache) put(domain string, image []byte, contentType string, at int64) error {
	var imgArg any
	if image == nil {
		imgArg = nil
	} else {
		imgArg = image
	}
	var ctArg any
	if contentType == "" {
		ctArg = nil
	} else {
		ctArg = contentType
	}
	_, err := c.db.Writer().Exec(
		`INSERT OR REPLACE INTO favicon_cache (domain, image, content_type, fetched_at) VALUES (?, ?, ?, ?)`,
		domain, imgArg, ctArg, at)
	return err
}

// fetchFromGoogle is the default fetch: Google's s2 favicon service at size 64.
func fetchFromGoogle(ctx context.Context, domain string) ([]byte, string, error) {
	u := "https://www.google.com/s2/favicons?domain=" + url.QueryEscape(domain) + "&sz=64"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, "", err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, "", &statusError{res.StatusCode}
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, "", err
	}
	ctype := res.Header.Get("Content-Type")
	if ctype == "" {
		ctype = "image/png"
	}
	return body, ctype, nil
}

type statusError struct{ code int }

func (e *statusError) Error() string { return "upstream status " + http.StatusText(e.code) }
