package db_test

import (
	"database/sql"
	"testing"
	"time"

	"rss-reader/server-go/internal/db"
)

func openInit(t *testing.T, path string) *db.DB {
	t.Helper()
	h, err := db.OpenHandle(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := db.InitSchema(h.Writer()); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return h
}

func hasColumn(t *testing.T, r *sql.DB, table, col string) bool {
	t.Helper()
	rows, err := r.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == col {
			return true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return false
}

// Title translation shipped briefly as a per-feed opt-in before becoming one
// global switch. A DB carrying the old column must come across with the switch on
// (rather than silently losing the setting) and the column gone.
func TestAdoptsRetiredPerFeedTranslateFlag(t *testing.T) {
	path := t.TempDir() + "/t.db"
	h := openInit(t, path)

	// Recreate the retired shape and turn it on for one feed.
	if _, err := h.Writer().Exec(
		`ALTER TABLE feeds ADD COLUMN translate_enabled INTEGER DEFAULT 0`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Writer().Exec(`UPDATE feeds SET translate_enabled = 1 WHERE rowid = 1`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Writer().Exec(
		`UPDATE llm_config SET enabled = 0, translate_since = NULL WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	h.Close()

	h = openInit(t, path)
	defer h.Close()

	if hasColumn(t, h.Reader(), "feeds", "translate_enabled") {
		t.Fatal("retired per-feed column still present")
	}
	var enabled int
	var since sql.NullInt64
	if err := h.Reader().QueryRow(`SELECT enabled, translate_since FROM llm_config WHERE id = 1`).
		Scan(&enabled, &since); err != nil {
		t.Fatal(err)
	}
	if enabled != 1 {
		t.Fatal("per-feed opt-in was not carried over to the global switch")
	}
	if !since.Valid {
		t.Fatal("watermark not seeded during adoption")
	}
	day := int64(24 * time.Hour / time.Millisecond)
	if delta := time.Now().UnixMilli() - since.Int64; delta < day-60_000 || delta > day+60_000 {
		t.Fatalf("watermark is %dms back, want ~%dms", delta, day)
	}
}

// A DB that never had the retired column must not be switched on by the adoption
// path — the default is off.
func TestFreshDBLeavesTranslationOff(t *testing.T) {
	h := openInit(t, t.TempDir()+"/t.db")
	defer h.Close()

	var enabled int
	var since sql.NullInt64
	if err := h.Reader().QueryRow(`SELECT enabled, translate_since FROM llm_config WHERE id = 1`).
		Scan(&enabled, &since); err != nil {
		t.Fatal(err)
	}
	if enabled != 0 || since.Valid {
		t.Fatalf("fresh DB has translation on: enabled=%d since=%v", enabled, since)
	}
}

// Re-running InitSchema must stay a no-op — it runs on every boot.
func TestInitSchemaIsIdempotent(t *testing.T) {
	path := t.TempDir() + "/t.db"
	h := openInit(t, path)
	if _, err := h.Writer().Exec(
		`UPDATE llm_config SET enabled = 1, translate_since = 1234 WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	h.Close()

	h = openInit(t, path)
	defer h.Close()
	var enabled int
	var since int64
	if err := h.Reader().QueryRow(`SELECT enabled, translate_since FROM llm_config WHERE id = 1`).
		Scan(&enabled, &since); err != nil {
		t.Fatal(err)
	}
	if enabled != 1 || since != 1234 {
		t.Fatalf("re-init clobbered config: enabled=%d since=%d", enabled, since)
	}
}
