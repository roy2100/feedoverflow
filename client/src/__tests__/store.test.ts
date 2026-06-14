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

  it('标记星标：isStarred 变 true，starredCount +1', () => {
    useStore.setState({ articles: [article], starredCount: 0 });
    useStore.getState().toggleStar(article);
    const { articles, starredCount } = useStore.getState();
    expect(articles[0].isStarred).toBe(true);
    expect(starredCount).toBe(1);
  });

  it('取消星标：isStarred 变 false，starredCount -1', () => {
    const starred = { ...article, isStarred: true };
    useStore.setState({ articles: [starred], starredCount: 1 });
    useStore.getState().toggleStar(starred);
    const { articles, starredCount } = useStore.getState();
    expect(articles[0].isStarred).toBe(false);
    expect(starredCount).toBe(0);
  });

  it('starred 视图下取消星标 → 文章从列表移除', () => {
    const starred = { ...article, isStarred: true };
    useStore.setState({ articles: [starred], selectedView: { type: 'starred' }, starredCount: 1 });
    useStore.getState().toggleStar(starred);
    expect(useStore.getState().articles).toHaveLength(0);
  });

  it('非 starred 视图下取消星标 → 文章保留在列表', () => {
    const starred = { ...article, isStarred: true };
    useStore.setState({ articles: [starred], selectedView: { type: 'all' }, starredCount: 1 });
    useStore.getState().toggleStar(starred);
    expect(useStore.getState().articles).toHaveLength(1);
  });

  it('starredCount 不低于 0（防御性）', () => {
    const starred = { ...article, isStarred: true };
    useStore.setState({ articles: [starred], starredCount: 0 });
    useStore.getState().toggleStar(starred);
    expect(useStore.getState().starredCount).toBe(0);
  });

  it('star/unstar 同步更新 selectedArticle', () => {
    useStore.setState({ articles: [article], selectedArticle: article, starredCount: 0 });
    useStore.getState().toggleStar(article);
    expect(useStore.getState().selectedArticle?.isStarred).toBe(true);
  });
});

// ─── selectArticle ───────────────────────────────────────────────────────────

describe('selectArticle', () => {
  it('选中文章后 selectedArticle 被设置', () => {
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

  it('删除后 feeds 列表移除该条目', async () => {
    useStore.setState({ feeds });
    await useStore.getState().deleteFeed('1');
    const remaining = useStore.getState().feeds;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('2');
  });

  it('删除当前正在查看的 feed → 切换到 all 视图', async () => {
    useStore.setState({ feeds, selectedView: { type: 'feed', feed: { id: '1' } as Feed } });
    await useStore.getState().deleteFeed('1');
    expect(useStore.getState().selectedView.type).toBe('all');
  });

  it('删除其他 feed → 当前视图不变', async () => {
    useStore.setState({ feeds, selectedView: { type: 'feed', feed: { id: '2' } as Feed } });
    await useStore.getState().deleteFeed('1');
    expect(useStore.getState().selectedView).toEqual({ type: 'feed', feed: { id: '2' } });
  });
});

// ─── loadArticles URL 映射 ───────────────────────────────────────────────────

describe('loadArticles URL 映射', () => {
  it.each<[View, string]>([
    [{ type: 'all' }, '/api/all-articles'],
    [{ type: 'today' }, '/api/today'],
    [{ type: 'starred' }, '/api/starred'],
    [{ type: 'feed', feed: { id: '5' } as Feed }, '/api/feeds/5/articles'],
  ])('view %o → 请求 %s', async (view, expectedUrl) => {
    await useStore.getState().loadArticles(view);
    expect(fetch).toHaveBeenCalledWith(expectedUrl, expect.any(Object));
  });

  it('加载完成后 loadingArticles 重置为 false', async () => {
    await useStore.getState().loadArticles({ type: 'all' });
    expect(useStore.getState().loadingArticles).toBe(false);
  });

  it('返回数据写入 articles', async () => {
    vi.stubGlobal('fetch', mockFetch({ articles: [{ id: 'x1' }] }));
    await useStore.getState().loadArticles({ type: 'all' });
    expect(useStore.getState().articles).toHaveLength(1);
  });
});
