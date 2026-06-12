import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

// Isolate every test run in its own temp DB so tests are repeatable.
const TEST_DB_PATH = join(tmpdir(), `rss-favicon-test-${process.pid}.db`);
process.env.TEST_DB = TEST_DB_PATH;

const { app } = await import('./app.ts');
const { db } = await import('./db.ts');
const { getFavicon, DEFAULT_FAVICON } = await import('./favicon.ts');

// ── Helpers ───────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
let server: Server;
let baseUrl: string;

/** Replace global fetch with a counter-tracking stub returning the given bytes. */
function stubFetch(bytes: Buffer | null, contentType = 'image/png') {
  const calls = { n: 0 };
  globalThis.fetch = (async () => {
    calls.n++;
    if (bytes === null) throw new Error('network down');
    return new Response(bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': contentType } });
  }) as typeof fetch;
  return calls;
}

before(async () => {
  await new Promise<void>(resolve => {
    server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

// Test-client requests must use the real fetch; only the route's *upstream* call
// is stubbed (both share globalThis.fetch in-process).
const httpGet = (path: string) => realFetch(`${baseUrl}${path}`);

beforeEach(() => {
  globalThis.fetch = realFetch; // reset any stub leaked from a prior test
  db.prepare('DELETE FROM favicon_cache').run();
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
  try { unlinkSync(TEST_DB_PATH); } catch {}
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes

// ── getFavicon (module contract) ──────────────────────────────────────────────

test('getFavicon — returns null for an invalid domain (no fetch, no row)', async () => {
  const calls = stubFetch(PNG);
  assert.equal(await getFavicon('not a domain'), null);
  assert.equal(await getFavicon('anthropic'), null);   // single-label hostname
  assert.equal(calls.n, 0, 'invalid input must not hit the network');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM favicon_cache').get() as { n: number }).n, 0);
});

test('getFavicon — miss fetches upstream and persists the bytes', async () => {
  const calls = stubFetch(PNG, 'image/x-icon');
  const result = await getFavicon('example.com');
  assert.equal(calls.n, 1);
  assert.deepEqual(result!.image, PNG);
  assert.equal(result!.contentType, 'image/x-icon');

  const row = db.prepare('SELECT image, content_type FROM favicon_cache WHERE domain = ?').get('example.com') as { image: Buffer; content_type: string };
  assert.deepEqual(row.image, PNG);
});

test('getFavicon — second call is served from cache without re-fetching', async () => {
  const calls = stubFetch(PNG);
  await getFavicon('example.com');
  await getFavicon('example.com');
  assert.equal(calls.n, 1, 'upstream should be hit only once');
});

test('getFavicon — upstream failure returns null and negative-caches', async () => {
  const calls = stubFetch(null);
  assert.equal(await getFavicon('broken.com'), null);
  assert.equal(calls.n, 1);

  const row = db.prepare('SELECT image FROM favicon_cache WHERE domain = ?').get('broken.com') as { image: Buffer | null };
  assert.equal(row.image, null, 'negative cache stores a NULL image');

  // A fresh negative row should be served without another upstream hit.
  assert.equal(await getFavicon('broken.com'), null);
  assert.equal(calls.n, 1, 'negative cache should suppress the retry within TTL');
});

test('getFavicon — empty upstream body is treated as a failure', async () => {
  stubFetch(Buffer.alloc(0));
  assert.equal(await getFavicon('empty.com'), null);
});

// ── GET /api/favicon (route behavior) ─────────────────────────────────────────

test('GET /api/favicon — serves the real icon with a 7-day cache header', async () => {
  stubFetch(PNG, 'image/png');
  const res = await httpGet(`/api/favicon?domain=example.com`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') ?? '', /max-age=604800/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
});

test('GET /api/favicon — invalid domain returns the default image (200, not an error)', async () => {
  const res = await httpGet(`/api/favicon?domain=anthropic`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /image\/svg\+xml/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), DEFAULT_FAVICON);
});

test('GET /api/favicon — upstream failure returns the default image (200)', async () => {
  stubFetch(null);
  const res = await httpGet(`/api/favicon?domain=broken.com`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /image\/svg\+xml/);
  assert.match(res.headers.get('cache-control') ?? '', /max-age=86400/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), DEFAULT_FAVICON);
});

test('GET /api/favicon — missing domain returns the default image (200)', async () => {
  const res = await httpGet(`/api/favicon`);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), DEFAULT_FAVICON);
});
