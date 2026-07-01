import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import request from 'supertest';

// Auth must be enabled (both vars set) before app.ts is imported: this suite asserts the
// loopback-only `localApp` stays auth-exempt precisely while the public `app` is gated.
process.env.AUTH_USER = 'admin';
process.env.AUTH_PASS = 's3cret';
process.env.TEST_DB = ':memory:';

const { app, localApp } = await import('../app.ts');

describe('local no-auth API', () => {
  test('serves /api without a session cookie while the public app is gated', async () => {
    // Public app: gated → 401 with no session.
    const gated = await request(app).get('/api/feeds');
    assert.equal(gated.status, 401);

    // Local app: same router, no auth → 200 without any cookie.
    const open = await request(localApp).get('/api/feeds');
    assert.equal(open.status, 200);
    assert.ok(Array.isArray(open.body));
  });
});

describe('MCP endpoint placement', () => {
  test('POST /mcp is served on localApp', async () => {
    const res = await request(localApp)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    // Reaches the MCP transport (not the 401 gate / SPA fallback).
    assert.notEqual(res.status, 401);
    assert.notEqual(res.status, 404);
  });

  test('GET /mcp on localApp returns 405 (no server-to-client stream)', async () => {
    const res = await request(localApp).get('/mcp');
    assert.equal(res.status, 405);
  });

  test('POST /mcp is not routed on the public app', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    // No MCP handler on the public app; the SPA fallback only handles GET, so POST 404s.
    assert.equal(res.status, 404);
  });
});
