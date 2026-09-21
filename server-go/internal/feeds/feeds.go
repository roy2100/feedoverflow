// Package feeds holds the pure domain helpers for feed management: RFC-4122 v4
// UUID minting (crypto.randomUUID) and recursive OPML outline extraction. The
// HTTP handlers and SQL live in httpapi/store; this package stays I/O-free so it
// is trivially testable. Port of the non-DB logic in server/routes/feeds.ts.
package feeds

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/xml"
	"strings"
)

// NewUUID returns a random RFC-4122 version-4 UUID string, matching Node's
// crypto.randomUUID() output shape (8-4-4-4-12 lowercase hex).
func NewUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand failure is unrecoverable
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// Candidate is one feed extracted from an OPML document.
type Candidate struct {
	Name string
	URL  string
}

// opmlOutline mirrors an <outline> node; it self-nests so the whole tree parses
// in one pass. xmlUrl carries the feed URL; text/title carry the display name.
type opmlOutline struct {
	XMLURL   string        `xml:"xmlUrl,attr"`
	Text     string        `xml:"text,attr"`
	Title    string        `xml:"title,attr"`
	Outlines []opmlOutline `xml:"outline"`
}

type opmlDoc struct {
	XMLName xml.Name      `xml:"opml"`
	Body    []opmlOutline `xml:"body>outline"`
}

// ParseOPML extracts every feed (any outline carrying xmlUrl, at any depth) from
// an OPML document, mirroring the recursive `extract` in the Node importer. Name
// falls back text → title → xmlUrl. Order is document order (depth-first).
func ParseOPML(data []byte) ([]Candidate, error) {
	var doc opmlDoc
	if err := xml.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	var out []Candidate
	var walk func(nodes []opmlOutline)
	walk = func(nodes []opmlOutline) {
		for _, n := range nodes {
			if n.XMLURL != "" {
				name := n.Text
				if name == "" {
					name = n.Title
				}
				if name == "" {
					name = n.XMLURL
				}
				out = append(out, Candidate{Name: name, URL: n.XMLURL})
			}
			if len(n.Outlines) > 0 {
				walk(n.Outlines)
			}
		}
	}
	walk(doc.Body)
	return out, nil
}

// TrimName trims a user-supplied feed name; empty after trim means "no override".
func TrimName(s string) string { return strings.TrimSpace(s) }

// opmlExport is the document BuildOPML writes. It is a separate type from opmlDoc
// because the reader is deliberately lax (any outline at any depth, name from
// three attributes) while the writer should emit one canonical shape: a flat
// body of `type="rss"` outlines with text, title and xmlUrl all set, which is
// what every importer reads.
type opmlExport struct {
	XMLName xml.Name      `xml:"opml"`
	Version string        `xml:"version,attr"`
	Title   string        `xml:"head>title"`
	Body    []opmlOutExpt `xml:"body>outline"`
}

type opmlOutExpt struct {
	Type   string `xml:"type,attr"`
	Text   string `xml:"text,attr"`
	Title  string `xml:"title,attr"`
	XMLURL string `xml:"xmlUrl,attr"`
}

// BuildOPML renders the subscription list as an OPML 2.0 document — the inverse of
// ParseOPML, so an export re-imports as the same set. Categories do not exist in
// this app, so the body is flat.
func BuildOPML(list []Candidate) ([]byte, error) {
	doc := opmlExport{Version: "2.0", Title: "feedoverflow 订阅"}
	for _, c := range list {
		doc.Body = append(doc.Body, opmlOutExpt{Type: "rss", Text: c.Name, Title: c.Name, XMLURL: c.URL})
	}
	out, err := xml.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, err
	}
	return append([]byte(xml.Header), append(out, '\n')...), nil
}
