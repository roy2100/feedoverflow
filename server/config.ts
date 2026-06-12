// Single source of truth for the listen port. Read from PORT (set in the plist
// / server/.env), defaulting to 3002. load-env.ts must run before this module is
// evaluated so the .env value is available — index.ts imports it first.
export const PORT = Number(process.env.PORT) || 3002;

// Soft cap on the logical SQLite DB size (page_count * page_size). When exceeded, the
// maintenance pass deletes the oldest non-starred articles down to ~90% of this value.
// Override via DB_MAX_SIZE_MB (server/.env or the plist); defaults to 500MB.
export const DB_MAX_SIZE_BYTES = (Number(process.env.DB_MAX_SIZE_MB) || 500) * 1024 * 1024;
