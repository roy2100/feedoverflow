import * as path from 'node:path';
import { createLogger, type Level } from './vendor/slog.ts';

// Resolve the log dir relative to this file (server/), not cwd: dev runs from `server/`
// while launchd runs from the deploy root, but `../logs` lands on the same `logs/` dir
// the deploy already uses in both cases. Override with LOG_DIR if needed.
const LOG_DIR = process.env.LOG_DIR || path.join(import.meta.dirname, '..', 'logs');

const isTest = !!process.env.TEST_DB;

// One shared logger. NDJSON to `logs/app.log` (rotated + gzipped + pruned); pretty,
// colorized output to the console only in a dev TTY. Under launchd there is no TTY, so
// the file is the source of truth and the raw stdout/stderr `server.log` stays quiet.
// Tests write nothing and stay silent.
export const logger = createLogger({
  dir: LOG_DIR,
  filename: 'app',
  level: (process.env.LOG_LEVEL as Level | undefined) ?? (isTest ? 'warn' : 'info'),
  base: { app: 'rss-reader' },
  file: !isTest,
  console: isTest ? false : 'auto',
});
