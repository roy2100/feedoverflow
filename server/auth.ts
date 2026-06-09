import crypto from 'node:crypto';
import type { Express, Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { db } from './db.ts';

export const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

export function parseCookies(req: Request): Record<string, string> {
  const list: Record<string, string> = {};
  const rc = req.headers.cookie;
  if (rc) rc.split(';').forEach(cookie => {
    const [k, ...v] = cookie.split('=');
    list[k.trim()] = decodeURIComponent(v.join('='));
  });
  return list;
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
});

const isLocalhost = (req: Request) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip ?? '');

export function registerAuth(app: Express): void {
  if (process.env.AUTH_USER && process.env.AUTH_PASS) {
    const stmtInsertSession = db.prepare('INSERT OR REPLACE INTO sessions (token, created_at) VALUES (?, ?)');
    const stmtDeleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
    const stmtFindSession   = db.prepare('SELECT created_at FROM sessions WHERE token = ?');
    const stmtCleanSessions = db.prepare('DELETE FROM sessions WHERE created_at < ?');

    app.post('/api/login', loginLimiter, (req, res) => {
      const { user, pass } = req.body ?? {};
      if (typeof user !== 'string' || typeof pass !== 'string') {
        return res.status(400).json({ error: 'Missing credentials' });
      }
      const expUser = process.env.AUTH_USER as string;
      const expPass = process.env.AUTH_PASS as string;
      const uBuf = Buffer.from(user), eBuf = Buffer.from(expUser);
      const pBuf = Buffer.from(pass), fBuf = Buffer.from(expPass);
      const userOk = uBuf.length === eBuf.length && crypto.timingSafeEqual(uBuf, eBuf);
      const passOk = pBuf.length === fBuf.length && crypto.timingSafeEqual(pBuf, fBuf);
      if (!userOk || !passOk) return res.status(401).json({ error: 'Invalid credentials' });
      const token = crypto.randomBytes(32).toString('hex');
      const now = Date.now();
      stmtInsertSession.run(token, now);
      stmtCleanSessions.run(now - SESSION_TTL);
      res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000; Path=/`);
      res.json({ ok: true });
    });

    app.post('/api/logout', (req, res) => {
      const token = parseCookies(req).session;
      if (token) stmtDeleteSession.run(token);
      res.setHeader('Set-Cookie', 'session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/');
      res.json({ ok: true });
    });

    app.get('/api/auth-check', (req, res) => {
      if (isLocalhost(req)) return res.json({ authed: true });
      const token = parseCookies(req).session;
      if (token) {
        const row = stmtFindSession.get(token) as { created_at: number } | undefined;
        if (row && Date.now() - row.created_at < SESSION_TTL) return res.json({ authed: true });
      }
      res.json({ authed: false });
    });

    app.use((req, res, next) => {
      if (!req.path.startsWith('/api/')) return next();
      if (isLocalhost(req)) return next();
      const token = parseCookies(req).session;
      if (token) {
        const row = stmtFindSession.get(token) as { created_at: number } | undefined;
        if (row && Date.now() - row.created_at < SESSION_TTL) return next();
      }
      res.status(401).json({ error: 'Unauthorized' });
    });
  }

  // Fallback when auth is disabled: always authed
  app.get('/api/auth-check', (_req, res) => res.json({ authed: true }));
}
