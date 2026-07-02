package feeds

import (
	"regexp"
	"testing"
)

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestNewUUIDShapeAndUniqueness(t *testing.T) {
	seen := map[string]bool{}
	for range 1000 {
		id := NewUUID()
		if !uuidRe.MatchString(id) {
			t.Fatalf("malformed v4 uuid: %q", id)
		}
		if seen[id] {
			t.Fatalf("duplicate uuid: %q", id)
		}
		seen[id] = true
	}
}

func TestParseOPMLNestedAndFallback(t *testing.T) {
	opml := `<?xml version="1.0"?>
<opml version="1.0">
  <body>
    <outline text="Tech" title="Tech folder">
      <outline text="Feed A" xmlUrl="https://a.example/feed"/>
      <outline title="Feed B" xmlUrl="https://b.example/feed"/>
    </outline>
    <outline xmlUrl="https://c.example/feed"/>
    <outline text="No URL folder"/>
  </body>
</opml>`
	got, err := ParseOPML([]byte(opml))
	if err != nil {
		t.Fatalf("ParseOPML: %v", err)
	}
	want := []Candidate{
		{Name: "Feed A", URL: "https://a.example/feed"},                 // text
		{Name: "Feed B", URL: "https://b.example/feed"},                 // title fallback
		{Name: "https://c.example/feed", URL: "https://c.example/feed"}, // url fallback
	}
	if len(got) != len(want) {
		t.Fatalf("count: got %d, want %d (%+v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("candidate %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestParseOPMLInvalid(t *testing.T) {
	if _, err := ParseOPML([]byte("<opml><body><outline")); err == nil {
		t.Fatal("expected error on malformed OPML")
	}
}

func TestTrimName(t *testing.T) {
	if got := TrimName("  hi  "); got != "hi" {
		t.Errorf("TrimName: got %q", got)
	}
	if got := TrimName("   "); got != "" {
		t.Errorf("TrimName all-space: got %q", got)
	}
}
