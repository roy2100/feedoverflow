// Robustly parse an RSS pubDate into a Date, or null when unparseable.
//
// Most feeds give RFC822 / ISO-8601 dates the browser parses natively, but some
// (e.g. 36氪 via RssHub) emit `2026-06-17 14:14:08  +0800`: a space instead of
// `T`, doubled whitespace, and a colon-less timezone offset. Safari/Chrome reject
// that, so the time silently rendered blank. We normalize it into ISO-8601 and retry.
export function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;

  const direct = new Date(dateStr);
  if (!isNaN(direct.getTime())) return direct;

  const normalized = dateStr
    .trim()
    .replace(/\s+/g, ' ') // collapse doubled whitespace
    .replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T') // date<space>time → date T time
    .replace(/ ?([+-]\d{2})(\d{2})$/, '$1:$2'); // +0800 → +08:00

  const retry = new Date(normalized);
  return isNaN(retry.getTime()) ? null : retry;
}
