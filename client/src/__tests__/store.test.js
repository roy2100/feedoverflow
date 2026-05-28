import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '../store';

const INITIAL_STATE = {
  feeds: [],
  articles: [],
  selectedView: { type: 'today' },
  selectedArticle: null,
  loadingArticles: false,
  starredCount: 0,
};

function mockFetch(json = { articles: [] }) {
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
  const article = { id: 'a1', isStarred: false, isRead: true };

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
    expect(useStore.getState().selectedArticle.isStarred).toBe(true);
  });
});

// ─── selectArticle ───────────────────────────────────────────────────────────

describe('selectArticle', () => {
  it('已读文章：直接设置 selectedArticle，不调用 fetch', () => {
    const article = { id: 'a1', isRead: true };
    useStore.setState({ articles: [article] });
    useStore.getState().selectArticle(article);
    expect(useStore.getState().selectedArticle).toEqual(article);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('未读文章：selectedArticle 和 articles 列表都标记为已读', () => {
    const article = { id: 'a1', isRead: false };
    useStore.setState({ articles: [article] });
    useStore.getState().selectArticle(article);
    const { selectedArticle, articles } = useStore.getState();
    expect(selectedArticle.isRead).toBe(true);
    expect(articles[0].isRead).toBe(true);
  });

  it('未读文章：调用 POST /api/articles/read', () => {
    const article = { id: 'a1', isRead: false };
    useStore.setState({ articles: [article] });
    useStore.getState().selectArticle(article);
    expect(fetch).toHaveBeenCalledWith(
      '/api/articles/read',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('选中文章不影响列表中其他文章的 isRead 状态', () => {
    const a1 = { id: 'a1', isRead: false };
    const a2 = { id: 'a2', isRead: false };
    useStore.setState({ articles: [a1, a2] });
    useStore.getState().selectArticle(a1);
    expect(useStore.getState().articles[1].isRead).toBe(false);
  });
});

// ─── deleteFeed ──────────────────────────────────────────────────────────────

describe('deleteFeed', () => {
  const feeds = [{ id: 1, name: 'Feed A' }, { id: 2, name: 'Feed B' }];

  it('删除后 feeds 列表移除该条目', async () => {
    useStore.setState({ feeds });
    await useStore.getState().deleteFeed(1);
    const remaining = useStore.getState().feeds;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(2);
  });

  it('删除当前正在查看的 feed → 切换到 all 视图', async () => {
    useStore.setState({ feeds, selectedView: { type: 'feed', feed: { id: 1 } } });
    await useStore.getState().deleteFeed(1);
    expect(useStore.getState().selectedView.type).toBe('all');
  });

  it('删除其他 feed → 当前视图不变', async () => {
    useStore.setState({ feeds, selectedView: { type: 'feed', feed: { id: 2 } } });
    await useStore.getState().deleteFeed(1);
    expect(useStore.getState().selectedView).toEqual({ type: 'feed', feed: { id: 2 } });
  });
});

// ─── loadArticles URL 映射 ───────────────────────────────────────────────────

describe('loadArticles URL 映射', () => {
  it.each([
    [{ type: 'all' }, '/api/all-articles'],
    [{ type: 'today' }, '/api/today'],
    [{ type: 'starred' }, '/api/starred'],
    [{ type: 'feed', feed: { id: 5 } }, '/api/feeds/5/articles'],
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
