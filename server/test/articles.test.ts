import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe, after } from 'node:test';

// articles.ts imports db.ts, which needs an isolated temp DB (resolveUrl reads settings).
const TEST_DB_PATH = join(tmpdir(), `rss-articles-test-${process.pid}.db`);
process.env.TEST_DB = TEST_DB_PATH;

const { normalizeDuration, resolveUrl } = await import('../articles.ts');
const { db } = await import('../db.ts');

after(() => {
  db.close();
  try {
    unlinkSync(TEST_DB_PATH);
  } catch {}
});

describe('normalizeDuration', () => {
  test('empty/undefined input returns empty string', () => {
    assert.equal(normalizeDuration(''), '');
    assert.equal(normalizeDuration(undefined), '');
  });

  test('already-formatted mm:ss / h:mm:ss values pass through unchanged', () => {
    assert.equal(normalizeDuration('3:45'), '3:45');
    assert.equal(normalizeDuration('1:02:03'), '1:02:03');
  });

  test('a raw seconds count is formatted as m:ss', () => {
    assert.equal(normalizeDuration('90'), '1:30');
    assert.equal(normalizeDuration('45'), '0:45');
    assert.equal(normalizeDuration('600'), '10:00');
  });

  test('an hour or more is formatted as h:mm:ss with zero-padding', () => {
    assert.equal(normalizeDuration('3661'), '1:01:01');
    assert.equal(normalizeDuration('7200'), '2:00:00');
  });

  test('a non-numeric, non-timestamp string is returned as-is', () => {
    assert.equal(normalizeDuration('abc'), 'abc');
  });
});

describe('resolveUrl', () => {
  test('a non-rsshub URL (or empty) is returned unchanged', () => {
    assert.equal(resolveUrl('https://example.com/feed'), 'https://example.com/feed');
    assert.equal(resolveUrl(''), '');
  });

  test('an rsshub:// URL is expanded against the seeded default base', () => {
    // db seeds rsshub_base_url = http://localhost:1200
    assert.equal(resolveUrl('rsshub://anthropic/news'), 'http://localhost:1200/anthropic/news');
  });

  test('a configured base URL is used and its trailing slash is stripped', () => {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'rsshub_base_url'").run(
      'http://rsshub.test:1200/',
    );
    assert.equal(resolveUrl('rsshub://a/b'), 'http://rsshub.test:1200/a/b');
  });

  test('falls back to the localhost default when the setting is absent', () => {
    db.prepare("DELETE FROM settings WHERE key = 'rsshub_base_url'").run();
    assert.equal(resolveUrl('rsshub://x/y'), 'http://localhost:1200/x/y');
  });
});
