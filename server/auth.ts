import crypto from 'node:crypto';

import type { Express, Request } from 'express';
import { rateLimit } from 'express-rate-limit';

import { db } from './db.ts';

export const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

export function parseCookies(req: Request): Record<string, string> {
  const list: Record<string, string> = {};
  const rc = req.headers.cookie;
  if (rc)
    rc.split(';').forEach((cookie) => {
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

export const isLocalhost = (req: Request) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip ?? '');

// `Secure` only when the request actually arrived over HTTPS. Over LAN HTTP
// (direct to :3002) iOS Safari drops Secure cookies, so login would never stick.
// `req.secure` is trustworthy because of `trust proxy = loopback` (cloudflared
// sets X-Forwarded-Proto: https for the public tunnel).
const sessionCookie = (req: Request, token: string, maxAge: number) =>
  `session=${token}; HttpOnly; ${req.secure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${maxAge}; Path=/`;

export function registerAuth(app: Express): void {
  if (process.env.AUTH_USER && process.env.AUTH_PASS) {
    const stmtInsertSession = db.prepare(
      'INSERT OR REPLACE INTO sessions (token, created_at) VALUES (?, ?)',
    );
    const stmtDeleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
    const stmtFindSession = db.prepare('SELECT created_at FROM sessions WHERE token = ?');
    const stmtCleanSessions = db.prepare('DELETE FROM sessions WHERE created_at < ?');

    app.post('/api/login', loginLimiter, (req, res) => {
      const { user, pass } = req.body ?? {};
      if (typeof user !== 'string' || typeof pass !== 'string') {
        return res.status(400).json({ error: 'Missing credentials' });
      }
      const expUser = process.env.AUTH_USER as string;
      const expPass = process.env.AUTH_PASS as string;
      const uBuf = Buffer.from(user),
        eBuf = Buffer.from(expUser);
      const pBuf = Buffer.from(pass),
        fBuf = Buffer.from(expPass);
      const userOk = uBuf.length === eBuf.length && crypto.timingSafeEqual(uBuf, eBuf);
      const passOk = pBuf.length === fBuf.length && crypto.timingSafeEqual(pBuf, fBuf);
      if (!userOk || !passOk) return res.status(401).json({ error: 'Invalid credentials' });
      const token = crypto.randomBytes(32).toString('hex');
      const now = Date.now();
      stmtInsertSession.run(token, now);
      stmtCleanSessions.run(now - SESSION_TTL);
      res.setHeader('Set-Cookie', sessionCookie(req, token, 2592000));
      res.json({ ok: true });
    });

    app.post('/api/logout', (req, res) => {
      const token = parseCookies(req).session;
      if (token) stmtDeleteSession.run(token);
      res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
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
        // Had a session but it's invalid/expired → 401 so the client reloads to re-login.
        return res.status(401).json({ error: 'Unauthorized' });
      }
      // No session: anonymous read-only public demo — GET passes, writes are blocked.
      if (req.method === 'GET') return next();
      res.status(403).json({ error: '只读演示模式，登录后可写' });
    });
  }

  // Fallback when auth is disabled: always authed
  app.get('/api/auth-check', (_req, res) => res.json({ authed: true }));
}
