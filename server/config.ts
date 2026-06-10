// Single source of truth for the listen port. Read from PORT (set in the plist
// / server/.env), defaulting to 3002. load-env.ts must run before this module is
// evaluated so the .env value is available — index.ts imports it first.
export const PORT = Number(process.env.PORT) || 3002;
