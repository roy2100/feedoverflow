// Package jobs holds the background workers: cache warming, the poller,
// maintenance (orphan cleanup + size cap + VACUUM), the WAL TRUNCATE checkpoint,
// and the resource monitor. Port of server/poller.ts + server/maintenance.ts +
// server/ln.ts (resource).
package jobs

import (
	"database/sql"
	"log/slog"
	"sort"
	"strings"

	"rss-reader/server-go/internal/dates"
	"rss-reader/server-go/internal/db"
)

const (
	// lowWatermark: trim to this fraction of the cap so we don't re-trigger next poll.
	lowWatermark = 0.9
	// deleteChunk: SQLite caps bound params (~999); delete ids in chunks below that.
	deleteChunk = 500
)

// dbSizeBytes is the logical DB size on disk = page_count * page_size (excludes
// the -wal/-shm sidecars; after a VACUUM the main file tracks this closely).
func dbSizeBytes(conn *sql.DB) (int64, error) {
	var pageCount, pageSize int64
	if err := conn.QueryRow(`PRAGMA page_count`).Scan(&pageCount); err != nil {
		return 0, err
	}
	if err := conn.QueryRow(`PRAGMA page_size`).Scan(&pageSize); err != nil {
		return 0, err
	}
	return pageCount * pageSize, nil
}

// CleanupOrphans deletes non-starred rows whose feed no longer exists. Starred
// rows are kept on purpose (a starred article survives feed removal). Returns rows
// deleted. Port of cleanupOrphans.
func CleanupOrphans(w *sql.DB, log *slog.Logger) (int64, error) {
	res, err := w.Exec(
		`DELETE FROM article_states WHERE is_starred = 0 AND feed_id NOT IN (SELECT id FROM feeds)`)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		log.Info("orphan articles removed", "deleted", n)
	}
	return n, nil
}

type candidate struct {
	id    string
	ts    int64
	bytes int64
}

// articleTs mirrors maintenance.ts articleTs: parse pub_date → epoch ms; else
// parse updated_at (the SQLite UTC datetime string); else 0.
func articleTs(pubDate, updatedAt string) int64 {
	if t, ok := dates.ParsePubDate(pubDate); ok {
		return t.UnixMilli()
	}
	if updatedAt != "" {
		// updated_at is datetime('now') → "2006-01-02 15:04:05" in UTC.
		if t, ok := dates.ParsePubDate(updatedAt); ok {
			return t.UnixMilli()
		}
	}
	return 0
}

// EnforceSizeCap trims the DB back under lowWatermark*capBytes when it exceeds the
// cap, deleting the oldest non-starred articles then VACUUMing to return space to
// the OS. Starred articles are never deleted. Returns rows deleted. Port of
// enforceSizeCap. Runs on the write pool (VACUUM needs the single writer).
func EnforceSizeCap(handle *db.DB, capBytes int64, log *slog.Logger) (int64, error) {
	w := handle.Writer()
	sizeBefore, err := dbSizeBytes(w)
	if err != nil {
		return 0, err
	}
	if sizeBefore <= capBytes {
		return 0, nil
	}
	target := int64(float64(capBytes) * lowWatermark)
	needFree := sizeBefore - target

	rows, err := handle.Reader().Query(
		`SELECT article_id, pub_date, updated_at, LENGTH(content) + LENGTH(summary) AS bytes
		 FROM article_states WHERE is_starred = 0`)
	if err != nil {
		return 0, err
	}
	var cands []candidate
	for rows.Next() {
		var id string
		var pub, upd sql.NullString
		var b sql.NullInt64
		if err := rows.Scan(&id, &pub, &upd, &b); err != nil {
			rows.Close()
			return 0, err
		}
		cands = append(cands, candidate{id: id, ts: articleTs(pub.String, upd.String), bytes: b.Int64})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	// Oldest first (stable, so equal-ts rows keep query order like JS sort).
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].ts < cands[j].ts })

	var toDelete []string
	var freed int64
	for _, c := range cands {
		toDelete = append(toDelete, c.id)
		freed += c.bytes
		if freed >= needFree {
			break
		}
	}
	if len(toDelete) == 0 {
		return 0, nil
	}

	if err := deleteInChunks(w, toDelete); err != nil {
		return 0, err
	}
	if _, err := w.Exec(`VACUUM`); err != nil {
		return 0, err
	}

	sizeAfter, err := dbSizeBytes(w)
	if err != nil {
		return 0, err
	}
	log.Info("size cap enforced",
		"capMB", capBytes/1048576, "beforeMB", sizeBefore/1048576,
		"afterMB", sizeAfter/1048576, "deleted", len(toDelete))
	if sizeAfter > capBytes {
		log.Warn("still over cap after trimming all non-starred articles",
			"afterMB", sizeAfter/1048576, "capMB", capBytes/1048576)
	}
	return int64(len(toDelete)), nil
}

// deleteInChunks deletes ids in one transaction, batched under the bound-param cap.
func deleteInChunks(w *sql.DB, ids []string) error {
	tx, err := w.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	for i := 0; i < len(ids); i += deleteChunk {
		end := i + deleteChunk
		if end > len(ids) {
			end = len(ids)
		}
		chunk := ids[i:end]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		args := make([]any, len(chunk))
		for j, id := range chunk {
			args[j] = id
		}
		if _, err := tx.Exec(
			`DELETE FROM article_states WHERE article_id IN (`+placeholders+`)`, args...); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// CheckpointWAL reclaims the WAL via a TRUNCATE checkpoint (shrinks the -wal
// sidecar to 0). SQLite's automatic checkpoint is PASSIVE and never shrinks the
// file; a periodic TRUNCATE keeps it bounded. Reports busy (readers/writers
// active) and no-ops; the next tick retries. Never throws. Port of checkpointWal.
func CheckpointWAL(w *sql.DB, log *slog.Logger) {
	var busy, logFrames, checkpointed int
	err := w.QueryRow(`PRAGMA wal_checkpoint(TRUNCATE)`).Scan(&busy, &logFrames, &checkpointed)
	if err != nil {
		log.Warn("wal checkpoint failed", "err", err)
		return
	}
	if busy != 0 {
		log.Debug("wal checkpoint busy — readers/writers active, will retry",
			"busy", busy, "log", logFrames, "checkpointed", checkpointed)
	}
}

// RunMaintenance is one maintenance pass: clear non-starred orphans, then enforce
// the size cap. Port of runMaintenance. Errors are logged, not propagated.
func RunMaintenance(handle *db.DB, capBytes int64, log *slog.Logger) {
	if _, err := CleanupOrphans(handle.Writer(), log); err != nil {
		log.Error("maintenance pass failed", "err", err)
		return
	}
	if _, err := EnforceSizeCap(handle, capBytes, log); err != nil {
		log.Error("maintenance pass failed", "err", err)
	}
}
