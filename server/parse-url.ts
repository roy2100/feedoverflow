import Parser from 'rss-parser';

interface ItemExtra {
  contentEncoded?: string;
  content?: string;
  author?: string;
  itunes?: { duration?: string; [key: string]: unknown };
}

export type RssItem = import('rss-parser').Item & ItemExtra;
export type ParsedFeed = import('rss-parser').Output<ItemExtra>;

function makeParser() {
  return new Parser<{}, ItemExtra>({
    timeout: 10000,
    headers: { 'User-Agent': 'RSS-Reader/1.0' },
    customFields: { item: [['content:encoded', 'contentEncoded']] },
  });
}

async function fetchFeedXml(url: string, signal?: AbortSignal): Promise<string> {
  const headers = { 'User-Agent': 'RSS-Reader/1.0', 'Accept': '*/*' };
  const timeout = AbortSignal.timeout(10000);
  // Combine the caller's signal (e.g. request-close) with the hard timeout so a
  // slow feed aborts at 10s even when the client stays connected.
  const fetchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(url, { headers, signal: fetchSignal });
  if (!res.ok) throw new Error(`Status code ${res.status}`);
  return await res.text();
}

export async function parseURL(url: string, signal?: AbortSignal): Promise<ParsedFeed> {
  const targetUrl = url.endsWith('/') ? url.slice(0, -1) : url;
  const xml = await fetchFeedXml(targetUrl, signal);
  return makeParser().parseString(xml);
}
