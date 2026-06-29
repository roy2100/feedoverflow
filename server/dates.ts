// The single source of truth for turning an RSS pubDate string into a Date. Most feeds give
// RFC822 / ISO-8601 dates that parse natively, but some (36氪 via RssHub) emit
// `2026-06-17 14:14:08  +0800`: a space instead of `T`, doubled whitespace, and a colon-less
// offset. Native `new Date()` returns Invalid Date for those, so we normalize and retry.
// The server owns this parse: it sorts by it and emits ISO-8601 (normalizePubDates) so the
// client never needs a second parser. Kept dependency-free (no db import) so db.ts can use
// it for the pub_ts backfill without an import cycle.
export function parsePubDate(dateStr: string | null | undefined): Date | null {
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

// Publish time as epoch ms for storage/sorting: parsed pub_date, else the provided fallback
// (fetch time at persist), else 0. Keeps date-less items orderable instead of pinned to epoch.
export function pubTs(pubDate: string | null | undefined, fallback: number): number {
  return parsePubDate(pubDate)?.getTime() ?? fallback;
}
