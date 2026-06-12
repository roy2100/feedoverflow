import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

// Isolate every test run in its own temp DB so tests are repeatable.
const TEST_DB_PATH = join(tmpdir(), `rss-favicon-test-${process.pid}.db`);
process.env.TEST_DB = TEST_DB_PATH;

const { db } = await import('./db.ts');
const { getFavicon } = await import('./favicon.ts');

// ── Helpers ───────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

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

beforeEach(() => {
  db.prepare('DELETE FROM favicon_cache').run();
});

after(() => {
  globalThis.fetch = realFetch;
  db.close();
  try { unlinkSync(TEST_DB_PATH); } catch {}
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes

// ── Tests ───────────────────────────────────────────────────────────────────

test('getFavicon — rejects an invalid domain', async () => {
  await assert.rejects(() => getFavicon('not a domain'), /invalid domain/);
  await assert.rejects(() => getFavicon('javascript:alert(1)'), /invalid domain/);
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
  const result = await getFavicon('broken.com');
  assert.equal(result, null);
  assert.equal(calls.n, 1);

  const row = db.prepare('SELECT image FROM favicon_cache WHERE domain = ?').get('broken.com') as { image: Buffer | null };
  assert.equal(row.image, null, 'negative cache stores a NULL image');

  // A fresh negative row should be served without another upstream hit.
  const again = await getFavicon('broken.com');
  assert.equal(again, null);
  assert.equal(calls.n, 1, 'negative cache should suppress the retry within TTL');
});

test('getFavicon — empty upstream body is treated as a failure', async () => {
  stubFetch(Buffer.alloc(0));
  const result = await getFavicon('empty.com');
  assert.equal(result, null);
});
