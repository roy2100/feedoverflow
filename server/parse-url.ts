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
  const res = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Status code ${res.status}`);
  return await res.text();
}

export async function parseURL(url: string, signal?: AbortSignal): Promise<ParsedFeed> {
  const targetUrl = url.endsWith('/') ? url.slice(0, -1) : url;
  const xml = await fetchFeedXml(targetUrl, signal);
  return makeParser().parseString(xml);
}
