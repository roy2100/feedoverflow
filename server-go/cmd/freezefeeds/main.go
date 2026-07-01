// Command freezefeeds stamps every feed's last_fetched_at to now in a *copy* of
// the DB, so the Node oracle's ensureFresh sees the feeds as fresh (within the
// 5-min TTL) and performs no network refresh — making the contract-diff
// deterministic. Guarded to refuse anything under a Deploy/ path so it can never
// touch the production DB.
package main

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

func main() {
	if len(os.Args) != 2 {
		log.Fatalf("usage: freezefeeds <db-copy-path>")
	}
	path := os.Args[1]
	if strings.Contains(path, "Deploy/") || strings.Contains(path, "/server/rss.db") {
		log.Fatalf("refusing to freeze a production-looking path: %s", path)
	}
	db, err := sql.Open("sqlite3", "file:"+path+"?_busy_timeout=5000")
	if err != nil {
		log.Fatalf("open: %v", err)
	}
	defer db.Close()
	// One connection so the UPDATE and the TRUNCATE checkpoint share it — otherwise
	// the pool can run the checkpoint on a different conn and leave the change in the
	// -wal, so a bare cp of the main file misses it.
	db.SetMaxOpenConns(1)
	res, err := db.Exec(`UPDATE feeds SET last_fetched_at = ?`, time.Now().UnixMilli())
	if err != nil {
		log.Fatalf("freeze: %v", err)
	}
	if _, err := db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		log.Fatalf("checkpoint: %v", err)
	}
	n, _ := res.RowsAffected()
	fmt.Printf("froze %d feeds fresh in %s\n", n, path)
}
