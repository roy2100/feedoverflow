import express from 'express';

import { getFavicon, DEFAULT_FAVICON, DEFAULT_CONTENT_TYPE } from '../favicon.ts';
import { assertSafeUrl } from '../ssrf.ts';

export const router = express.Router();

router.get('/api/fetch-content', async (req, res) => {
  const url = req.query.url as string | undefined;
  if (!url) return res.status(400).json({ error: 'url required' });
  // This endpoint fetches a client-supplied URL, so block private/loopback/metadata
  // targets (SSRF defense-in-depth).
  try {
    await assertSafeUrl(url);
  } catch (err) {
    return res.status(400).json({ error: 'Blocked URL', detail: (err as Error).message });
  }
  const fetchHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  try {
    const response = await fetch(url, {
      headers: fetchHeaders,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return res.status(502).json({ error: `Upstream ${response.status}` });
    const html = await response.text();
    // jsdom + Readability are ~100MB resident and only needed for this on-demand
    // extraction, so load them lazily on first use instead of at boot. Node caches the
    // modules after the first import, so subsequent requests pay nothing.
    const { JSDOM } = await import('jsdom');
    const { Readability } = await import('@mozilla/readability');
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) return res.status(422).json({ error: 'Could not extract content' });
    res.json({ content: article.content, title: article.title, byline: article.byline });
  } catch (err) {
    res.status(500).json({ error: 'Fetch failed', detail: (err as Error).message });
  }
});

router.get('/api/favicon', async (req, res) => {
  const domain = (req.query.domain as string | undefined) ?? '';
  let result = null;
  try {
    result = await getFavicon(domain);
  } catch {
    /* fall through to default */
  }
  if (result) {
    res.set('Cache-Control', 'public, max-age=604800'); // overrides the global /api no-store
    res.type(result.contentType).send(result.image);
  } else {
    // A missing favicon is normal — serve a placeholder (200) so the browser logs no
    // error. Short TTL so a real icon is picked up once the negative cache expires.
    res.set('Cache-Control', 'public, max-age=86400');
    res.type(DEFAULT_CONTENT_TYPE).send(DEFAULT_FAVICON);
  }
});
