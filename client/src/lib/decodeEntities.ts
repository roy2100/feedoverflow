// Decode HTML entities (e.g. `&#160;`, `&#8217;`) in plain-text fields that are
// rendered as React text nodes. React text nodes and DOM attributes never decode
// entities, and titles/tag-less content skip the browser's HTML parser entirely —
// this mirrors the backend's html.UnescapeString pass on the summary field, which
// the raw title/content fields never go through.
export function decodeEntities(text: string): string {
  if (typeof DOMParser === 'undefined') return text;
  const doc = new DOMParser().parseFromString(text, 'text/html');
  return doc.documentElement.textContent ?? text;
}
