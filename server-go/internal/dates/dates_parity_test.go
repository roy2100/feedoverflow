package dates_test

import (
	"encoding/json"
	"os"
	"testing"
	"time"
	_ "time/tzdata" // embed zoneinfo so the test is self-contained on any host

	"rss-reader/server-go/internal/articles"
	"rss-reader/server-go/internal/dates"
)

// TestMain pins time.Local to Asia/Shanghai — the zone the oracle was generated
// in (the server's zone). Zoneless pub_dates parse in the local zone, so the test
// must run in that zone regardless of the host's TZ. Production must likewise run
// in Asia/Shanghai (see dates.go).
func TestMain(m *testing.M) {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		panic(err)
	}
	time.Local = loc
	os.Exit(m.Run())
}

// oracle mirrors the JSON emitted by gen_oracle.mjs (from the real dates.ts +
// articles.ts). The committed testdata/oracle.json holds a curated sample; point
// RSS_ORACLE at a full dump to gate the whole production date set.
type oracle struct {
	Fallback int64 `json:"fallback"`
	Dates    []struct {
		Input string `json:"input"`
		Ms    *int64 `json:"ms"`
		Iso   string `json:"iso"`
	} `json:"dates"`
	PubTsCases []struct {
		Input string `json:"input"`
		PubTs int64  `json:"pubTs"`
	} `json:"pubTsCases"`
	IDCases []struct {
		Link    string `json:"link"`
		Title   string `json:"title"`
		PubDate string `json:"pubDate"`
		ID      string `json:"id"`
	} `json:"idCases"`
	DurCases []struct {
		Input string `json:"input"`
		Out   string `json:"out"`
	} `json:"durCases"`
}

func loadOracle(t *testing.T) oracle {
	t.Helper()
	path := os.Getenv("RSS_ORACLE")
	if path == "" {
		path = "testdata/oracle.json"
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read oracle %s: %v", path, err)
	}
	var o oracle
	if err := json.Unmarshal(b, &o); err != nil {
		t.Fatalf("parse oracle: %v", err)
	}
	return o
}

// TestParsePubDateParity: Go ParsePubDate must reproduce Node's epoch-ms and
// toISOString() for every input, and null↔false must agree.
func TestParsePubDateParity(t *testing.T) {
	o := loadOracle(t)
	if len(o.Dates) == 0 {
		t.Fatal("oracle has no date cases")
	}
	mism := 0
	for _, d := range o.Dates {
		got, ok := dates.ParsePubDate(d.Input)
		if d.Ms == nil {
			if ok {
				mism++
				if mism <= 20 {
					t.Errorf("input %q: Node=null, Go=%d", d.Input, got.UnixMilli())
				}
			}
			continue
		}
		if !ok {
			mism++
			if mism <= 20 {
				t.Errorf("input %q: Node=%d, Go=null", d.Input, *d.Ms)
			}
			continue
		}
		if got.UnixMilli() != *d.Ms {
			mism++
			if mism <= 20 {
				t.Errorf("input %q: ms Node=%d Go=%d", d.Input, *d.Ms, got.UnixMilli())
			}
			continue
		}
		if iso := dates.ISOString(*d.Ms); iso != d.Iso {
			mism++
			if mism <= 20 {
				t.Errorf("input %q: iso Node=%q Go=%q", d.Input, d.Iso, iso)
			}
		}
	}
	if mism > 0 {
		t.Fatalf("%d/%d date parity mismatches", mism, len(o.Dates))
	}
	t.Logf("date parity OK over %d inputs", len(o.Dates))
}

func TestPubTsParity(t *testing.T) {
	o := loadOracle(t)
	for _, c := range o.PubTsCases {
		if got := dates.PubTs(c.Input, o.Fallback); got != c.PubTs {
			t.Errorf("pubTs %q: Node=%d Go=%d", c.Input, c.PubTs, got)
		}
	}
}

func TestMakeIDParity(t *testing.T) {
	o := loadOracle(t)
	for _, c := range o.IDCases {
		if got := articles.MakeID(c.Link, c.Title, c.PubDate); got != c.ID {
			t.Errorf("makeId(%q,%q,%q): Node=%s Go=%s", c.Link, c.Title, c.PubDate, c.ID, got)
		}
	}
}

func TestNormalizeDurationParity(t *testing.T) {
	o := loadOracle(t)
	for _, c := range o.DurCases {
		if got := articles.NormalizeDuration(c.Input); got != c.Out {
			t.Errorf("normalizeDuration(%q): Node=%q Go=%q", c.Input, c.Out, got)
		}
	}
}
