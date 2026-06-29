import assert from 'node:assert/strict';
import { test, describe, before } from 'node:test';

import request from 'supertest';

// Auth only registers its routes/gate when both vars are set — must be in place
// before app.ts is imported. Use an isolated in-memory DB.
process.env.AUTH_USER = 'admin';
process.env.AUTH_PASS = 's3cret';
process.env.TEST_DB = ':memory:';

const { app } = await import('../app.ts');
const { db } = await import('../db.ts');
const { SESSION_TTL } = await import('../auth.ts');

// The gate now engages for every request, local or remote. REMOTE simply
// simulates an external client (trust proxy = loopback reads X-Forwarded-For).
const REMOTE = '203.0.113.7';
const sessionFromSetCookie = (header: string[] | undefined) => {
  const cookie = (header ?? []).find((c) => c.startsWith('session='));
  return cookie ? cookie.split(';')[0] : '';
};

describe('auth — login', () => {
  test('rejects missing/non-string credentials with 400', async () => {
    const res = await request(app).post('/api/login').send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Missing credentials');
  });

  test('rejects wrong password with 401', async () => {
    const res = await request(app).post('/api/login').send({ user: 'admin', pass: 'nope' });
    assert.equal(res.status, 401);
  });

  test('rejects wrong-length username with 401 (length guard before timingSafeEqual)', async () => {
    const res = await request(app).post('/api/login').send({ user: 'a', pass: 's3cret' });
    assert.equal(res.status, 401);
  });

  test('accepts correct credentials, sets HttpOnly session cookie + persists row', async () => {
    const res = await request(app).post('/api/login').send({ user: 'admin', pass: 's3cret' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const cookie = sessionFromSetCookie(setCookie);
    assert.ok(cookie.startsWith('session='), 'expected a session cookie');
    assert.match(setCookie[0], /HttpOnly/);
    const token = cookie.slice('session='.length);
    const row = db.prepare('SELECT token FROM sessions WHERE token = ?').get(token);
    assert.ok(row, 'session row should be persisted');
  });
});

describe('auth — gate on /api/*', () => {
  let cookie: string;

  before(async () => {
    const res = await request(app).post('/api/login').send({ user: 'admin', pass: 's3cret' });
    cookie = sessionFromSetCookie(res.headers['set-cookie'] as unknown as string[]);
  });

  test('localhost requests are gated too (no cookie → 401)', async () => {
    const res = await request(app).get('/api/feeds'); // supertest connects from 127.0.0.1
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');
  });

  test('remote request without a cookie is rejected with 401', async () => {
    const res = await request(app).get('/api/feeds').set('X-Forwarded-For', REMOTE);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');
  });

  test('remote request with a valid cookie passes', async () => {
    const res = await request(app)
      .get('/api/feeds')
      .set('X-Forwarded-For', REMOTE)
      .set('Cookie', cookie);
    assert.equal(res.status, 200);
  });

  test('remote request with an expired session is rejected', async () => {
    const token = 'expired-token';
    db.prepare('INSERT OR REPLACE INTO sessions (token, created_at) VALUES (?, ?)').run(
      token,
      Date.now() - SESSION_TTL - 1000,
    );
    const res = await request(app)
      .get('/api/feeds')
      .set('X-Forwarded-For', REMOTE)
      .set('Cookie', `session=${token}`);
    assert.equal(res.status, 401);
  });

  test('remote request with an unknown token is rejected', async () => {
    const res = await request(app)
      .get('/api/feeds')
      .set('X-Forwarded-For', REMOTE)
      .set('Cookie', 'session=does-not-exist');
    assert.equal(res.status, 401);
  });
});

describe('auth — auth-check & logout', () => {
  test('auth-check reports authed:false for localhost without cookie (no bypass)', async () => {
    const res = await request(app).get('/api/auth-check');
    assert.deepEqual(res.body, { authed: false });
  });

  test('auth-check reports authed:false for remote without cookie', async () => {
    const res = await request(app).get('/api/auth-check').set('X-Forwarded-For', REMOTE);
    assert.deepEqual(res.body, { authed: false });
  });

  test('auth-check reports authed:true for remote with valid cookie', async () => {
    const login = await request(app).post('/api/login').send({ user: 'admin', pass: 's3cret' });
    const cookie = sessionFromSetCookie(login.headers['set-cookie'] as unknown as string[]);
    const res = await request(app)
      .get('/api/auth-check')
      .set('X-Forwarded-For', REMOTE)
      .set('Cookie', cookie);
    assert.deepEqual(res.body, { authed: true });
  });

  test('logout deletes the session row and the cookie stops working', async () => {
    const login = await request(app).post('/api/login').send({ user: 'admin', pass: 's3cret' });
    const cookie = sessionFromSetCookie(login.headers['set-cookie'] as unknown as string[]);
    const token = cookie.slice('session='.length);

    await request(app).post('/api/logout').set('Cookie', cookie).expect(200);
    const row = db.prepare('SELECT token FROM sessions WHERE token = ?').get(token);
    assert.equal(row, undefined, 'session row should be deleted');

    const res = await request(app)
      .get('/api/feeds')
      .set('X-Forwarded-For', REMOTE)
      .set('Cookie', cookie);
    assert.equal(res.status, 401);
  });
});
