// Chapter timestamps in podcast show notes — `(04:41) Signing in…`, `(1:52) Impact
// of…`, `1:02:30` — turned into seek offsets. Both reader branches (the HTML body
// and the plain-text fallback) split text through this one function so their idea
// of "a timestamp" cannot drift. Rationale: docs/plan-podcast-chapter-seek.md.

export type TimestampSegment = { text: string; seconds?: number };

// m:ss, mm:ss or h:mm:ss. The trailing guard rejects `12:345` and `1:8080`; the
// leading guard is checked by hand below instead of a lookbehind, which older iOS
// Safari lacks.
const TIMESTAMP_RE = /(\d{1,2}):(\d{2})(?::(\d{2}))?(?![\d:])/g;

function gluedToPrevious(text: string, index: number): boolean {
  if (index === 0) return false;
  const prev = text[index - 1];
  return (prev >= '0' && prev <= '9') || prev === ':';
}

/** `h:mm:ss` / `m:ss` → seconds, or null when a field is out of range. */
export function parseTimestamp(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  return fieldsToSeconds(m[1], m[2], m[3]);
}

function fieldsToSeconds(a: string, b: string, c: string | undefined): number | null {
  const first = Number(a);
  const second = Number(b);
  if (c === undefined) {
    // m:ss — seconds bounded; minutes take the whole first field.
    if (second > 59) return null;
    return first * 60 + second;
  }
  const third = Number(c);
  if (second > 59 || third > 59) return null;
  return first * 3600 + second * 60 + third;
}

/**
 * Splits `text` into plain runs and timestamp runs. Segments with `seconds` are the
 * timestamps; the concatenation of every `text` is the input, unchanged.
 */
export function splitTimestamps(text: string): TimestampSegment[] {
  const out: TimestampSegment[] = [];
  let last = 0;
  TIMESTAMP_RE.lastIndex = 0;
  for (let m = TIMESTAMP_RE.exec(text); m; m = TIMESTAMP_RE.exec(text)) {
    if (gluedToPrevious(text, m.index)) continue;
    const seconds = fieldsToSeconds(m[1], m[2], m[3]);
    if (seconds === null) continue;
    // Show notes bracket their chapters — `(04:41)`, `[1:52]`. Pull the pair into
    // the segment so the chip is the whole marker, not a clock with orphaned
    // parentheses hanging off it at body size.
    let start = m.index;
    let end = m.index + m[0].length;
    const open = text[start - 1];
    const close = text[end];
    if ((open === '(' && close === ')') || (open === '[' && close === ']')) {
      start--;
      end++;
    }
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: text.slice(start, end), seconds });
    last = end;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
