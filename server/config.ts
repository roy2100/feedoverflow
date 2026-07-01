// Single source of truth for the listen port. Read from PORT (set in the plist
// / server/.env), defaulting to 3002. load-env.ts must run before this module is
// evaluated so the .env value is available — index.ts imports it first.
export const PORT = Number(process.env.PORT) || 3002;

// Loopback-only companion port. A second Express listener bound to 127.0.0.1 serves the
// full API with NO auth gate and hosts the MCP endpoint (/mcp). "Whether auth applies" is
// decided by which socket the request arrived on — this port never leaves the loopback
// interface (the rathole tunnel forwards only PORT), so it must bind to 127.0.0.1, never
// 0.0.0.0. Override via LOCAL_API_PORT; defaults to 4002 (3000 dev client, 3001 networth,
// 3002 public rss).
export const LOCAL_API_PORT = Number(process.env.LOCAL_API_PORT) || 4002;

// Soft cap on the logical SQLite DB size (page_count * page_size). When exceeded, the
// maintenance pass deletes the oldest non-starred articles down to ~90% of this value.
// Override via DB_MAX_SIZE_MB (server/.env or the plist); defaults to 2GB — the app durably
// persists every fetched article for statistics/research, so the store is expected to grow.
export const DB_MAX_SIZE_BYTES = (Number(process.env.DB_MAX_SIZE_MB) || 2048) * 1024 * 1024;
