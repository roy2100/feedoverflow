import { db } from './db.ts';
import { logger } from './logger.ts';

// Favicons rarely change; refetch a successful one only every 30 days. A failed
// fetch is cached as a NULL-image "negative" row and retried after 1 day.
const POSITIVE_TTL = 30 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL =       24 * 60 * 60 * 1000;

// Conservative hostname check — letters/digits/hyphens in dot-separated labels.
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

interface FaviconRow { image: Buffer | null; content_type: string | null; fetched_at: number }

const stmtGet = db.prepare('SELECT image, content_type, fetched_at FROM favicon_cache WHERE domain = ?');
const stmtPut = db.prepare(
  'INSERT OR REPLACE INTO favicon_cache (domain, image, content_type, fetched_at) VALUES (?, ?, ?, ?)'
);

export interface FaviconResult {
  image: Buffer;
  contentType: string;
}

/**
 * Returns the cached favicon bytes for a domain, fetching + persisting on a miss.
 * `null` means "no icon available" — the caller should respond 404 so the client
 * falls back to its placeholder. Throws only on invalid input.
 */
export async function getFavicon(domain: string): Promise<FaviconResult | null> {
  if (!DOMAIN_RE.test(domain)) throw new Error('invalid domain');

  const row = stmtGet.get(domain) as FaviconRow | undefined;
  if (row) {
    const fresh = row.image
      ? Date.now() - row.fetched_at < POSITIVE_TTL
      : Date.now() - row.fetched_at < NEGATIVE_TTL;
    if (fresh) {
      return row.image ? { image: row.image, contentType: row.content_type || 'image/png' } : null;
    }
  }

  try {
    const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`);
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const contentType = res.headers.get('content-type') || 'image/png';
    const image = Buffer.from(await res.arrayBuffer());
    if (image.length === 0) throw new Error('empty body');
    stmtPut.run(domain, image, contentType, Date.now());
    return { image, contentType };
  } catch (err) {
    logger.warn('favicon fetch failed', { domain, err });
    stmtPut.run(domain, null, null, Date.now()); // negative cache
    return null;
  }
}
