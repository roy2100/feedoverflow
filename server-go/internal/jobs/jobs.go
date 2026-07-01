// Package jobs holds the background workers: cache warming, the poller,
// maintenance (orphan cleanup + size cap + VACUUM), the WAL TRUNCATE checkpoint,
// and the resource monitor. Port of server/poller.ts + server/maintenance.ts.
//
// Phase 0: skeleton only — background jobs are Phase 9.
package jobs
