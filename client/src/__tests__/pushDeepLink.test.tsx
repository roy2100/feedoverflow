import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import App from '../App';
import { useStore } from '../store';
import type { Article } from '../types';

// The push deep link (App.tsx) is the one path that opens an article the current
// list does not contain. It has two arrivals — `?article=<id>` on a cold start and
// a service-worker message when a window is already open — and both are invisible
// to every other test, so this file covers them end to end through <App />.

function article(over: Partial<Article> = {}): Article {
  return {
    id: 'push-1',
    feedId: 'f1',
    feedName: 'HN',
    title: '推送文章',
    summary: '',
    content: '<p>pushed</p>',
    link: 'https://example.com/pushed',
    pubDate: '2026-07-25T00:00:00Z',
    author: '',
    audioUrl: '',
    audioDuration: '',
    isStarred: false,
    ...over,
  };
}

const PUSHED = article();
const IN_LIST = article({ id: 'today-1', title: '今日文章', link: 'https://example.com/today' });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

// Resolves /api/today only when the test says so, so the boot-order race can be
// driven deliberately rather than hoped for.
type FetchImpl = (input: RequestInfo | URL) => Promise<Response>;

let todayGate = deferred<void>();
let fetchMock: ReturnType<typeof vi.fn>;
// The default routing table, so a test can override one route and delegate the rest.
let routed: FetchImpl;

function installFetch() {
  routed = (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth-check')) return Promise.resolve(jsonRes({ authed: true }));
    if (url.includes('/api/starred/count')) return Promise.resolve(jsonRes({ count: 0 }));
    // Before the bare /api/feeds route: a feed's article list shares the prefix.
    if (url.includes('/articles') && url.includes('/api/feeds/'))
      return Promise.resolve(jsonRes({ articles: [] }));
    if (url.includes('/api/feeds'))
      return Promise.resolve(jsonRes([{ id: 'f1', name: 'HN', url: 'https://hn.example/rss' }]));
    if (url.includes('/api/today'))
      return todayGate.promise.then(() => jsonRes({ articles: [IN_LIST] }));
    if (url.includes('/api/articles/') && url.includes('/content'))
      return Promise.resolve(jsonRes({ content: PUSHED.content }));
    if (url.includes('/api/articles/')) return Promise.resolve(jsonRes({ article: PUSHED }));
    return Promise.resolve(jsonRes({}));
  };
  fetchMock = vi.fn(routed);
  vi.stubGlobal('fetch', fetchMock);
}

// jsdom has no ServiceWorkerContainer; App registers a `message` listener on it for
// the already-open arrival path. Capture the handler so a push can be simulated.
let swHandlers: Array<(e: MessageEvent) => void> = [];

function installServiceWorker() {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      addEventListener: (type: string, h: (e: MessageEvent) => void) => {
        if (type === 'message') swHandlers.push(h);
      },
      removeEventListener: (type: string, h: (e: MessageEvent) => void) => {
        if (type === 'message') swHandlers = swHandlers.filter((x) => x !== h);
      },
      startMessages: vi.fn(),
    },
  });
}

function pushArrives(id: string) {
  return act(async () => {
    swHandlers.forEach((h) => h({ data: { type: 'open-article', id } } as MessageEvent));
    // Let the by-id fetch settle.
    await Promise.resolve();
  });
}

async function releaseToday() {
  await act(async () => {
    todayGate.resolve();
    await Promise.resolve();
  });
}

// The reader is panel index 2, so z-index 3 — the panel stack is what the mobile
// layout navigates, and `transform` is the only observable of which one is on top.
function readerPanel(): HTMLElement {
  const el = document.querySelector('div[style*="z-index: 3"]');
  if (!el) throw new Error('reader panel not rendered');
  return el as HTMLElement;
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 375 });
  window.history.replaceState(null, '', '/');
  useStore.setState({
    feeds: [],
    articles: [],
    selectedView: { type: 'today' },
    selectedArticle: null,
    loadingArticles: false,
    starredCount: 0,
    lastListView: { type: 'today' },
  });
  todayGate = deferred<void>();
  swHandlers = [];
  installFetch();
  installServiceWorker();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
  window.history.replaceState(null, '', '/');
});

describe('push deep link — cold start (?article=)', () => {
  it('opens the named article and strips the param from the URL', async () => {
    window.history.replaceState(null, '', '/?article=push-1');

    render(<App />);

    expect(await screen.findByText('推送文章')).toBeInTheDocument();
    expect(useStore.getState().selectedArticle?.id).toBe('push-1');
    // Left in place it would re-open the article on every reload, and follow any
    // bookmark or share of the URL.
    expect(window.location.search).toBe('');
  });

  it('keeps other query params while stripping only `article`', async () => {
    window.history.replaceState(null, '', '/?foo=bar&article=push-1');

    render(<App />);

    await screen.findByText('推送文章');
    expect(window.location.search).toBe('?foo=bar');
  });

  it('survives the boot list arriving after it', async () => {
    // The regression this guards: the cold-start boot fires loadArticles('today')
    // alongside the deep link, and loadArticles clears selectedArticle. It clears
    // synchronously before its own await, so the deep link — which resolves later —
    // must win. Reorder those effects and the reader silently empties out.
    window.history.replaceState(null, '', '/?article=push-1');

    render(<App />);
    await screen.findByText('推送文章');

    await releaseToday();

    expect(useStore.getState().selectedArticle?.id).toBe('push-1');
    expect(useStore.getState().articles.map((a) => a.id)).toEqual(['today-1']);
    expect(screen.getByText('推送文章')).toBeInTheDocument();
  });
});

describe('push deep link — already-open window (service-worker message)', () => {
  it('opens the article over the current list without disturbing it', async () => {
    render(<App />);
    await releaseToday();
    expect(useStore.getState().articles.map((a) => a.id)).toEqual(['today-1']);

    await pushArrives('push-1');

    expect(await screen.findByText('推送文章')).toBeInTheDocument();
    // The list behind the reader is left exactly as it was, so closing the article
    // returns the user where the notification interrupted them. The old deep-link
    // path switched to the article's own feed and refetched, destroying it.
    expect(useStore.getState().selectedView).toEqual({ type: 'today' });
    expect(useStore.getState().articles.map((a) => a.id)).toEqual(['today-1']);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/feeds/f1/articles'))).toBe(
      false,
    );
  });

  it('ignores messages that are not an article hand-off', async () => {
    render(<App />);
    await releaseToday();

    await act(async () => {
      swHandlers.forEach((h) =>
        h({ data: { type: 'something-else', id: 'push-1' } } as MessageEvent),
      );
      swHandlers.forEach((h) => h({ data: { type: 'open-article' } } as MessageEvent));
      await Promise.resolve();
    });

    expect(useStore.getState().selectedArticle).toBeNull();
  });

  it('leaves the reader closed when the article is gone', async () => {
    // Trimmed by the size cap, or a stale notification: /api/articles/:id 404s.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/articles/'))
        return Promise.resolve({ ok: false, status: 404 } as Response);
      return routed(input);
    });

    render(<App />);
    await pushArrives('gone');

    expect(useStore.getState().selectedArticle).toBeNull();
  });
});

describe('push deep link — back out of the reader', () => {
  it('the ← arrow slides the reader panel away', async () => {
    window.history.replaceState(null, '', '/?article=push-1');

    render(<App />);
    await screen.findByText('推送文章');
    expect(readerPanel().style.transform).toBe('translateX(0)');

    fireEvent.click(screen.getByText('文章列表'));

    // Back is the in-app arrow only — there is no history entry behind the reader
    // and no popstate involved (docs/plan-drop-mobile-history.md).
    expect(readerPanel().style.transform).toBe('translateX(100%)');
  });
});
