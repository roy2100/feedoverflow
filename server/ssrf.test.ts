import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { afterEach, mock, test } from 'node:test';

import { assertSafeUrl } from './ssrf.ts';

afterEach(() => {
  mock.restoreAll();
});

// Helper: assert the promise rejects with a message matching `msg`.
async function rejects(p: Promise<unknown>, msg: string | RegExp) {
  await assert.rejects(p, (err: Error) => {
    assert.match(err.message, typeof msg === 'string' ? new RegExp(msg) : msg);
    return true;
  });
}

test('rejects malformed URLs', async () => {
  await rejects(assertSafeUrl('not a url'), 'Invalid URL');
  await rejects(assertSafeUrl(''), 'Invalid URL');
});

test('rejects non-http(s) protocols', async () => {
  await rejects(assertSafeUrl('ftp://example.com/x'), 'Only http/https');
  await rejects(assertSafeUrl('file:///etc/passwd'), 'Only http/https');
  await rejects(assertSafeUrl('gopher://example.com'), 'Only http/https');
});

test('blocks literal private/loopback/link-local IPv4 addresses', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '192.168.0.1',
    '172.16.5.5',
    '169.254.169.254', // cloud metadata endpoint
    '100.64.0.1', // CGNAT
    '0.0.0.0',
  ]) {
    await rejects(assertSafeUrl(`http://${ip}/`), 'Blocked address');
  }
});

test('blocks literal private/loopback IPv6 addresses', async () => {
  for (const host of [
    '[::1]', // loopback
    '[::]', // unspecified
    '[fc00::1]', // unique-local
    '[fe80::1]', // link-local
    // IPv4-mapped literals: the URL parser rewrites these to hex-compressed form
    // (e.g. [::ffff:7f00:1]), which must still be decoded back to the private IPv4.
    '[::ffff:127.0.0.1]', // → loopback
    '[::ffff:10.0.0.1]', // → private
    '[::ffff:169.254.169.254]', // → cloud metadata
  ]) {
    await rejects(assertSafeUrl(`http://${host}/`), 'Blocked address');
  }
});

test('blocks IPv4-mapped IPv6 addresses returned by DNS (dotted form)', async () => {
  // dns.lookup can yield the dotted `::ffff:a.b.c.d` form, which the guard
  // strips back to IPv4 before classifying.
  for (const address of ['::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
    mock.method(dns, 'lookup', async () => [{ address, family: 6 }]);
    await rejects(assertSafeUrl('http://mapped.example.com/'), 'Blocked address');
    mock.restoreAll();
  }
});

test('still allows public IPv4-mapped IPv6 addresses', async () => {
  // The mapped-address path must not over-block: a mapped *public* IPv4 is fine.
  await assertSafeUrl('http://[::ffff:8.8.8.8]/');
});

test('allows literal public IP addresses without DNS lookup', async () => {
  const lookup = mock.method(dns, 'lookup');
  await assertSafeUrl('http://8.8.8.8/');
  await assertSafeUrl('https://1.1.1.1/path');
  await assertSafeUrl('http://[2606:4700:4700::1111]/'); // public IPv6
  assert.equal(lookup.mock.callCount(), 0, 'literal IPs skip DNS resolution');
});

test('allows hostnames that resolve to public addresses', async () => {
  mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  await assertSafeUrl('https://example.com/page');
});

test('blocks hostnames that resolve to a private address', async () => {
  // DNS-rebinding-style: a public-looking host pointing at the internal network.
  mock.method(dns, 'lookup', async () => [{ address: '10.0.0.5', family: 4 }]);
  await rejects(assertSafeUrl('http://evil.example.com/'), 'Blocked address');
});

test('blocks when any resolved address is private', async () => {
  mock.method(dns, 'lookup', async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '192.168.1.1', family: 4 },
  ]);
  await rejects(assertSafeUrl('http://mixed.example.com/'), 'Blocked address');
});

test('rejects hostnames that do not resolve', async () => {
  mock.method(dns, 'lookup', async () => []);
  await rejects(assertSafeUrl('http://nxdomain.invalid/'), 'did not resolve');
});
