// Command dbinit opens the SQLite DB at its single path argument and runs the Go
// schema init/migrations. Used by the Phase 1 parity check to produce a fresh
// Go-initialized schema for diffing against the Node build. Read/write on the
// given file only — never point it at production.
package main

import (
	"fmt"
	"log"
	"os"

	"rss-reader/server-go/internal/db"
)

func main() {
	if len(os.Args) != 2 {
		log.Fatalf("usage: dbinit <db-path>")
	}
	sqldb, err := db.Open(os.Args[1])
	if err != nil {
		log.Fatalf("open: %v", err)
	}
	defer sqldb.Close()
	if err := db.InitSchema(sqldb); err != nil {
		log.Fatalf("init schema: %v", err)
	}
	fmt.Println("schema init ok")
}
