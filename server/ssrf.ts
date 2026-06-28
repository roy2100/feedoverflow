import dns from 'node:dns/promises';
import net from 'node:net';

// SSRF guard for server-side fetches of client-supplied URLs (e.g. /api/fetch-content,
// which on the public read-only demo is reachable anonymously). Resolves the host and
// refuses to fetch anything that points at a private / loopback / link-local / metadata
// address, so a visitor can't make the server probe the internal network.
//
// Known limitation: fetch() re-resolves DNS independently, so a determined attacker could
// rebind between this check and the fetch. Acceptable for a low-value home demo; pin the
// resolved IP if this ever guards something sensitive.

function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  const inRange = (base: string, bits: number) =>
    n >>> (32 - bits) === ipv4ToInt(base) >>> (32 - bits);
  return (
    inRange('0.0.0.0', 8) || // "this" network
    inRange('10.0.0.0', 8) || // private
    inRange('100.64.0.0', 10) || // CGNAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local (incl. 169.254.169.254 metadata)
    inRange('172.16.0.0', 12) || // private
    inRange('192.168.0.0', 16) // private
  );
}

// Expand any valid IPv6 string to its 8 numeric groups (handles `::` compression and a
// trailing embedded IPv4, e.g. `::ffff:1.2.3.4`). Returns null for non-IPv6 input.
function ipv6Groups(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null;
  let str = ip.toLowerCase();
  const v4 = str.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    str =
      str.slice(0, v4.index) +
      ((p[0] << 8) | p[1]).toString(16) +
      ':' +
      ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, tail] = str.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail === undefined ? null : tail ? tail.split(':') : [];
  const groups =
    tailGroups === null
      ? headGroups
      : [
          ...headGroups,
          ...Array(8 - headGroups.length - tailGroups.length).fill('0'),
          ...tailGroups,
        ];
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g || '0', 16));
}

// Return the dotted IPv4 of an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, in any
// notation the URL parser / DNS may hand us), else null. Catches the hex-compressed
// form (`::ffff:7f00:1`) that a plain dotted-decimal regex would miss.
function mappedIPv4(ip: string): string | null {
  const g = ipv6Groups(ip);
  if (!g) return null;
  const highBitsZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (!highBitsZero || g[5] !== 0xffff) return null;
  return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
}

function isPrivateIP(ip: string): boolean {
  const mapped = mappedIPv4(ip); // IPv4-mapped IPv6
  if (mapped) return isPrivateIPv4(mapped);
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  const first = parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/** Throws if `raw` is not an http(s) URL or resolves to a non-public address. */
export async function assertSafeUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (net.isIP(host)) {
    if (isPrivateIP(host)) throw new Error('Blocked address');
    return;
  }
  const records = await dns.lookup(host, { all: true });
  if (records.length === 0) throw new Error('Host did not resolve');
  for (const { address } of records) {
    if (isPrivateIP(address)) throw new Error('Blocked address');
  }
}
