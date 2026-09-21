import { describe, it, expect, vi, afterEach } from 'vitest';

import { aiParagraphs, isMostlyHan, requestArticleAI } from '../lib/articleAI';

function sse(frames: string, init: ResponseInit = {}) {
  return new Response(frames, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    ...init,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('requestArticleAI', () => {
  it('posts the text and delivers pieces in order, then the done frame', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sse(
          'data: {"piece":"第一段"}\n\ndata: {"piece":"第二段"}\n\ndata: {"done":true,"model":"m"}\n\n',
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const pieces: string[] = [];

    const res = await requestArticleAI('a b', 'translation', 'Body', (p) => pieces.push(p));

    expect(pieces).toEqual(['第一段', '第二段']);
    expect(res).toEqual({ cached: false, model: 'm' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/articles/a%20b/ai',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ kind: 'translation', text: 'Body' }),
      }),
    );
  });

  it('reassembles frames split across chunk boundaries', async () => {
    const encoder = new TextEncoder();
    const chunks = ['data: {"pie', 'ce":"你好"}\n\nda', 'ta: {"done":true,"cached":true}\n\n'];
    const body = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        ),
    );
    const pieces: string[] = [];
    const res = await requestArticleAI('a', 'summary', 'x', (p) => pieces.push(p));
    expect(pieces).toEqual(['你好']);
    expect(res.cached).toBe(true);
  });

  it('throws the server message from a JSON rejection before the stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{"error":"请先在设置中配置翻译服务"}', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(requestArticleAI('a', 'summary', 'x', () => {})).rejects.toThrow(
      '请先在设置中配置翻译服务',
    );
  });

  it('throws an error frame after delivering the pieces before it', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(sse('data: {"piece":"第一段"}\n\ndata: {"error":"服务返回错误"}\n\n')),
    );
    const pieces: string[] = [];
    await expect(requestArticleAI('a', 'translation', 'x', (p) => pieces.push(p))).rejects.toThrow(
      '服务返回错误',
    );
    expect(pieces).toEqual(['第一段']);
  });

  it('treats a stream that ends without done as an interruption', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse('data: {"piece":"半截"}\n\n')));
    await expect(requestArticleAI('a', 'translation', 'x', () => {})).rejects.toThrow('连接中断');
  });
});

describe('isMostlyHan', () => {
  it('mirrors the server rule', () => {
    expect(isMostlyHan('这是一篇中文文章')).toBe(true);
    expect(isMostlyHan('苹果发布 M5 芯片')).toBe(true);
    expect(isMostlyHan('Apple unveils the M5 chip today')).toBe(false);
    expect(isMostlyHan('12:30 — 45%')).toBe(true);
    expect(isMostlyHan('')).toBe(true);
  });
});

describe('aiParagraphs', () => {
  it('splits on blank lines and drops empties', () => {
    expect(aiParagraphs('a\n\n\n b \n\nc\n')).toEqual(['a', 'b', 'c']);
  });
});
