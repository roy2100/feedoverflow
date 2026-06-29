import path from 'node:path';
import { fileURLToPath } from 'node:url';

import compression from 'compression';
import cors from 'cors';
import express from 'express';

import { registerAuth } from './auth.ts';
import { registerMcp } from './mcp.ts';
import { router as articlesRouter } from './routes/articles.ts';
import { router as contentRouter } from './routes/content.ts';
import { router as feedsRouter } from './routes/feeds.ts';
import { router as searchRouter } from './routes/search.ts';
import { router as settingsRouter } from './routes/settings.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../client/dist');

const ALLOWED_ORIGINS = ['http://localhost:3000', 'https://rss.royl.uk', 'https://rss.lan'];

export const app = express();
// Behind the Cloudflare Tunnel, cloudflared connects from 127.0.0.1, so without
// this the real client IP is masked and every public request looks like localhost.
// Trust the loopback hop to read the real IP from cloudflared's X-Forwarded-For.
app.set('trust proxy', 'loopback');
app.use(compression());
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(distDir));

registerAuth(app);

// ── API routers ──────────────────────────────────────────────────────────────
// Mounted after registerAuth so the /api auth gate (installed there) covers them,
// and before registerMcp + the SPA fallback. Each router carries full /api/... paths.
app.use(feedsRouter);
app.use(settingsRouter);
app.use(contentRouter);
app.use(articlesRouter);
app.use(searchRouter);

// MCP server over Streamable HTTP — must be before the SPA fallback
registerMcp(app);

// SPA fallback — must be after all /api routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

// Background services (cache warming, poller, DB maintenance) are started by index.ts
// only after the server successfully binds its port — not at import time.
