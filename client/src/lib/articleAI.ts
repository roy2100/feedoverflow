// On-demand article AI: a Chinese summary or a body translation, streamed from
// POST /api/articles/:id/ai as server-sent events. See server-go/internal/httpapi/ai.go.

export type AIKind = 'summary' | 'translation';

export interface AIResult {
  /** The server replayed a stored answer for this exact text — no model call. */
  cached: boolean;
  model: string;
}

interface AIEvent {
  piece?: string;
  done?: boolean;
  cached?: boolean;
  model?: string;
  error?: string;
}

/**
 * Sends the text the reader is showing and streams the answer back piece by piece.
 * The client sends the text (rather than the server reading the stored body) because
 * what is on screen may be the extracted 全文, which the server never keeps — and
 * "translate what I am looking at" is the only behaviour that is not a surprise.
 *
 * Anything before the stream starts (400/404/503) arrives as JSON and is thrown with
 * the server's message; once streaming, an `error` frame is thrown the same way, with
 * every piece received so far already delivered through `onPiece`.
 */
export async function requestArticleAI(
  articleId: string,
  kind: AIKind,
  text: string,
  onPiece: (piece: string) => void,
  signal?: AbortSignal,
): Promise<AIResult> {
  const r = await fetch(`/api/articles/${encodeURIComponent(articleId)}/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, text }),
    signal,
  });
  const contentType = r.headers.get('content-type') || '';
  if (!r.ok || !contentType.includes('text/event-stream')) {
    let message = `请求失败（HTTP ${r.status}）`;
    try {
      const data = await r.json();
      if (data?.error) message = data.error;
    } catch {
      // not JSON — keep the status line
    }
    throw new Error(message);
  }
  if (!r.body) throw new Error('浏览器不支持流式响应');

  let result: AIResult | null = null;
  const handleFrame = (frame: string) => {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const ev: AIEvent = JSON.parse(line.slice(5).trim());
      if (ev.error) throw new Error(ev.error);
      if (ev.piece) onPiece(ev.piece);
      if (ev.done) result = { cached: !!ev.cached, model: ev.model || '' };
    }
  };

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Frames end in a blank line; a chunk boundary can land anywhere, so only
    // complete frames are handled and the tail waits for the next read.
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      handleFrame(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleFrame(buffer);
  if (!result) throw new Error('连接中断，请重试');
  return result;
}

/**
 * Whether a body needs no translation — the client-side twin of the server's
 * IsMostlyChinese, with the same 30% rule: a Chinese article routinely carries Latin
 * product names, and a wrong hide only costs a menu item.
 */
export function isMostlyHan(text: string): boolean {
  let letters = 0;
  let han = 0;
  for (const ch of text) {
    if (/\p{Script=Han}/u.test(ch)) {
      han++;
      letters++;
    } else if (/\p{L}/u.test(ch)) {
      letters++;
    }
  }
  if (letters === 0) return true;
  return han / letters >= 0.3;
}

/** Splits a streamed answer into display paragraphs. */
export function aiParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}
