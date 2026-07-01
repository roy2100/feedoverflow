package articles

import (
	"database/sql"
	"os"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

// TestArticleIDRecomputeParity recomputes article_id from the stored
// link/title/pub_date of every row in a copy of the production DB and asserts it
// equals the stored article_id. A mismatch means a re-fetch would insert a
// duplicate row instead of upserting — the core Phase 2 risk. Point RSS_PARITY_DB
// at a *copy* of rss.db (never production); skips when unset.
func TestArticleIDRecomputeParity(t *testing.T) {
	path := os.Getenv("RSS_PARITY_DB")
	if path == "" {
		t.Skip("set RSS_PARITY_DB to a copy of rss.db to run the full-row id parity check")
	}
	db, err := sql.Open("sqlite3", "file:"+path+"?mode=ro&_busy_timeout=5000")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	rows, err := db.Query(`SELECT article_id, link, title, pub_date FROM article_states`)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()

	var total, mism int
	for rows.Next() {
		var id string
		var link, title, pubDate sql.NullString
		if err := rows.Scan(&id, &link, &title, &pubDate); err != nil {
			t.Fatalf("scan: %v", err)
		}
		total++
		got := MakeID(link.String, title.String, pubDate.String)
		if got != id {
			mism++
			if mism <= 20 {
				t.Errorf("row %d: stored=%s recomputed=%s link=%q", total, id, got, link.String)
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	if total == 0 {
		t.Fatal("no rows scanned")
	}
	if mism > 0 {
		t.Fatalf("article_id parity: %d/%d mismatches", mism, total)
	}
	t.Logf("article_id parity OK: %d/%d rows match", total, total)
}
