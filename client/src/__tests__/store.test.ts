import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { useStore } from '../store';
import type { Article, Feed, View } from '../types';

const INITIAL_STATE = {
  feeds: [],
  articles: [],
  selectedView: { type: 'today' } as View,
  selectedArticle: null,
  loadingArticles: false,
  starredCount: 0,
  lastListView: { type: 'today' } as View,
  scopedSearch: false,
};

function mockFetch(json: unknown = { articles: [] }) {
  return vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(json) }));
}

beforeEach(() => {
  useStore.setState(INITIAL_STATE);
  vi.stubGlobal('fetch', mockFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── toggleStar ─────────────────────────────────────────────────────────────

describe('toggleStar', () => {
  const article = { id: 'a1', isStarred: false } as Article;

  it('star: isStarred becomes true, starredCount +1', () => {
    useStore.setState({ articles: [article], starredCount: 0 });
    useStore.getState().toggleStar(article);
    const { articles, starredCount } = useStore.getState();
    expect(articles[0].isStarred).toBe(true);
    expect(starredCount).toBe(1);
  });

  it('unstar: isStarred becomes false, starredCount -1', () => {
    const starred = { ...article, isStarred: true };
    useStore.setState({ articles: [starred], starredCount: 1 });
    useStore.getState().toggleStar(starred);
    const { articles, starredCount } = useStore.getState();
    expect(articles[0].isStarred).toBe(false);
    expect(starredCount).toBe(0);
  });

  it('unstar in starred view removes the article from the list', () => {
    const starred = { ...article, isStarred: true };
    useStore.setState({ articles: [starred], selectedView: { type: 'starred' }, starredCount: 1 });
    useStore.getState().toggleStar(starred);
    expect(useStore.getState().articles).toHaveLength(0);
  });

  it('unstar in a non-starred view keeps the article in the list', () => {
    const starred = { ...article, isStarred: true };
    useStore.setState({ articles: [starred], selectedView: { type: 'all' }, starredCount: 1 });
    useStore.getState().toggleStar(starred);
    expect(useStore.getState().articles).toHaveLength(1);
  });

  it('starredCount never drops below 0 (defensive)', () => {
    const starred = { ...article, isStarred: true };
    useStore.setState({ articles: [starred], starredCount: 0 });
    useStore.getState().toggleStar(starred);
    expect(useStore.getState().starredCount).toBe(0);
  });

  it('star/unstar also updates selectedArticle', () => {
    useStore.setState({ articles: [article], selectedArticle: article, starredCount: 0 });
    useStore.getState().toggleStar(article);
    expect(useStore.getState().selectedArticle?.isStarred).toBe(true);
  });
});

// ─── selectArticle ───────────────────────────────────────────────────────────

describe('selectArticle', () => {
  it('sets selectedArticle when an article is selected', () => {
    const article = { id: 'a1' } as Article;
    useStore.setState({ articles: [article] });
    useStore.getState().selectArticle(article);
    expect(useStore.getState().selectedArticle).toEqual(article);
  });
});

// ─── deleteFeed ──────────────────────────────────────────────────────────────

describe('deleteFeed', () => {
  const feeds = [
    { id: '1', name: 'Feed A' },
    { id: '2', name: 'Feed B' },
  ] as Feed[];

  it('removes the entry from the feeds list after deletion', async () => {
    useStore.setState({ feeds });
    await useStore.getState().deleteFeed('1');
    const remaining = useStore.getState().feeds;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('2');
  });

  it('deleting the currently viewed feed switches to the all view', async () => {
    useStore.setState({ feeds, selectedView: { type: 'feed', feed: { id: '1' } as Feed } });
    await useStore.getState().deleteFeed('1');
    expect(useStore.getState().selectedView.type).toBe('all');
  });

  it('deleting another feed leaves the current view unchanged', async () => {
    useStore.setState({ feeds, selectedView: { type: 'feed', feed: { id: '2' } as Feed } });
    await useStore.getState().deleteFeed('1');
    expect(useStore.getState().selectedView).toEqual({ type: 'feed', feed: { id: '2' } });
  });
});

// ─── loadArticles URL mapping ────────────────────────────────────────────────

describe('loadArticles URL mapping', () => {
  it.each<[View, string]>([
    [{ type: 'all' }, '/api/all-articles?mode=latest'],
    [{ type: 'today' }, '/api/today?mode=latest'],
    [{ type: 'starred' }, '/api/starred'],
    [{ type: 'feed', feed: { id: '5' } as Feed }, '/api/feeds/5/articles'],
  ])('view %o requests %s', async (view, expectedUrl) => {
    await useStore.getState().loadArticles(view);
    expect(fetch).toHaveBeenCalledWith(expectedUrl, expect.any(Object));
  });

  it('resets loadingArticles to false after loading', async () => {
    await useStore.getState().loadArticles({ type: 'all' });
    expect(useStore.getState().loadingArticles).toBe(false);
  });

  it('writes returned data into articles', async () => {
    vi.stubGlobal('fetch', mockFetch({ articles: [{ id: 'x1' }] }));
    await useStore.getState().loadArticles({ type: 'all' });
    expect(useStore.getState().articles).toHaveLength(1);
  });
});

// ─── loadArticles URL — search scope ─────────────────────────────────────────

describe('loadArticles search URL', () => {
  it('global search (no scope) hits /api/search?q=', async () => {
    await useStore.getState().loadArticles({ type: 'search', query: 'kw' });
    expect(fetch).toHaveBeenCalledWith('/api/search?q=kw', expect.any(Object));
  });

  it('feed scope appends scope=feed&feedId=', async () => {
    await useStore.getState().loadArticles({
      type: 'search',
      query: 'kw',
      scope: { kind: 'feed', feedId: '7', feedName: 'F' },
    });
    expect(fetch).toHaveBeenCalledWith('/api/search?q=kw&scope=feed&feedId=7', expect.any(Object));
  });

  it('starred scope appends scope=starred', async () => {
    await useStore.getState().loadArticles({
      type: 'search',
      query: 'kw',
      scope: { kind: 'starred' },
    });
    expect(fetch).toHaveBeenCalledWith('/api/search?q=kw&scope=starred', expect.any(Object));
  });

  it('URL-encodes the query', async () => {
    await useStore.getState().loadArticles({ type: 'search', query: 'a b&c' });
    expect(fetch).toHaveBeenCalledWith('/api/search?q=a%20b%26c', expect.any(Object));
  });
});

// ─── search ──────────────────────────────────────────────────────────────────

describe('search', () => {
  it('query too short (<2) falls back to lastListView', () => {
    useStore.setState({ lastListView: { type: 'all' } });
    useStore.getState().search('a');
    expect(useStore.getState().selectedView.type).toBe('all');
  });

  it('normal query sets selectedView to search with the query', () => {
    useStore.getState().search('hello');
    expect(useStore.getState().selectedView).toMatchObject({ type: 'search', query: 'hello' });
  });

  it('scope off leaves selectedView.scope undefined', () => {
    useStore.setState({
      scopedSearch: false,
      lastListView: { type: 'feed', feed: { id: '7', name: 'F' } as Feed },
    });
    useStore.getState().search('kw');
    expect(useStore.getState().selectedView.scope).toBeUndefined();
  });

  it('scope on with feed base carries feedId/feedName', () => {
    useStore.setState({
      scopedSearch: true,
      lastListView: { type: 'feed', feed: { id: '7', name: 'F' } as Feed },
    });
    useStore.getState().search('kw');
    expect(useStore.getState().selectedView.scope).toEqual({
      kind: 'feed',
      feedId: '7',
      feedName: 'F',
    });
  });

  it('scope on with starred base sets scope.kind to starred', () => {
    useStore.setState({ scopedSearch: true, lastListView: { type: 'starred' } });
    useStore.getState().search('kw');
    expect(useStore.getState().selectedView.scope).toEqual({ kind: 'starred' });
  });

  it('scope on with non-scopable base (all) leaves scope undefined', () => {
    useStore.setState({ scopedSearch: true, lastListView: { type: 'all' } });
    useStore.getState().search('kw');
    expect(useStore.getState().selectedView.scope).toBeUndefined();
  });
});

// ─── toggleSearchScope ───────────────────────────────────────────────────────

describe('toggleSearchScope', () => {
  it('flips the scopedSearch boolean', () => {
    expect(useStore.getState().scopedSearch).toBe(false);
    useStore.getState().toggleSearchScope();
    expect(useStore.getState().scopedSearch).toBe(true);
  });

  it('toggling during an active search re-runs it with the scope', () => {
    useStore.setState({
      scopedSearch: false,
      selectedView: { type: 'search', query: 'kw' },
      lastListView: { type: 'feed', feed: { id: '7', name: 'F' } as Feed },
    });
    useStore.getState().toggleSearchScope();
    expect(useStore.getState().scopedSearch).toBe(true);
    expect(useStore.getState().selectedView.scope).toMatchObject({ kind: 'feed', feedId: '7' });
  });

  it('toggling off again clears the scope', () => {
    useStore.setState({
      scopedSearch: true,
      selectedView: { type: 'search', query: 'kw', scope: { kind: 'starred' } },
      lastListView: { type: 'starred' },
    });
    useStore.getState().toggleSearchScope();
    expect(useStore.getState().scopedSearch).toBe(false);
    expect(useStore.getState().selectedView.scope).toBeUndefined();
  });

  it('toggling outside a search view does not trigger a search', () => {
    useStore.setState({ selectedView: { type: 'all' } });
    useStore.getState().toggleSearchScope();
    expect(useStore.getState().selectedView.type).toBe('all');
  });
});

// ─── selectView lastListView tracking ───────────────────────────────────────

describe('selectView records lastListView', () => {
  it('selecting a non-search view updates lastListView', () => {
    const view: View = { type: 'feed', feed: { id: '9', name: 'Nine' } as Feed };
    useStore.getState().selectView(view);
    expect(useStore.getState().lastListView).toEqual(view);
  });

  it('a search view does not overwrite lastListView', () => {
    useStore.setState({ lastListView: { type: 'all' } });
    useStore.getState().selectView({ type: 'search', query: 'x' });
    expect(useStore.getState().lastListView).toEqual({ type: 'all' });
  });
});

// ─── init ────────────────────────────────────────────────────────────────────

function mockFetchByUrl(map: Record<string, unknown>) {
  return vi.fn((url: string) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(map[url] ?? {}) }),
  );
}

describe('init', () => {
  it('loads feeds and starredCount from the two endpoints', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchByUrl({
        '/api/feeds': [{ id: '1', name: 'A' }],
        '/api/starred/count': { count: 3 },
      }),
    );
    await useStore.getState().init();
    const { feeds, starredCount } = useStore.getState();
    expect(feeds).toHaveLength(1);
    expect(starredCount).toBe(3);
  });

  it('defaults starredCount to 0 when count is missing', async () => {
    vi.stubGlobal('fetch', mockFetchByUrl({ '/api/feeds': [], '/api/starred/count': {} }));
    await useStore.getState().init();
    expect(useStore.getState().starredCount).toBe(0);
  });

  it('swallows fetch errors and leaves state intact', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network'))),
    );
    await useStore.getState().init();
    expect(useStore.getState().feeds).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─── addFeed ──────────────────────────────────────────────────────────────────

describe('addFeed', () => {
  it('appends the returned feed on success', async () => {
    vi.stubGlobal('fetch', mockFetch({ id: '9', name: 'New', url: 'http://x' }));
    useStore.setState({ feeds: [{ id: '1', name: 'A' } as Feed] });
    await useStore.getState().addFeed({ url: 'http://x' });
    const { feeds } = useStore.getState();
    expect(feeds).toHaveLength(2);
    expect(feeds[1]).toMatchObject({ id: '9', name: 'New' });
  });

  it('throws with the server error message when the response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'duplicate' }) }),
      ),
    );
    await expect(useStore.getState().addFeed({ url: 'http://x' })).rejects.toThrow('duplicate');
    expect(useStore.getState().feeds).toEqual([]);
  });

  it('throws a default message when the error response has no message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })),
    );
    await expect(useStore.getState().addFeed({ url: 'http://x' })).rejects.toThrow('添加失败');
  });
});

// ─── importFeeds ──────────────────────────────────────────────────────────────

describe('importFeeds', () => {
  it('appends the imported feeds to the existing list', () => {
    useStore.setState({ feeds: [{ id: '1', name: 'A' } as Feed] });
    useStore
      .getState()
      .importFeeds([{ id: '2', name: 'B' } as Feed, { id: '3', name: 'C' } as Feed]);
    expect(useStore.getState().feeds.map((f) => f.id)).toEqual(['1', '2', '3']);
  });
});

// ─── updateFeed ───────────────────────────────────────────────────────────────

describe('updateFeed', () => {
  it('renames the matching feed and leaves others unchanged', async () => {
    useStore.setState({
      feeds: [{ id: '1', name: 'Old' } as Feed, { id: '2', name: 'Keep' } as Feed],
    });
    await useStore.getState().updateFeed('1', { name: 'Renamed' });
    const feeds = useStore.getState().feeds;
    expect(feeds[0].name).toBe('Renamed');
    expect(feeds[1].name).toBe('Keep');
  });
});
