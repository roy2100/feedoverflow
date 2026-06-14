import { create } from 'zustand';

import type { Article, Feed, View } from './types';

const API = '/api';
let loadAbortController: AbortController | null = null;

async function apiFetch(url: string, opts?: RequestInit): Promise<Response> {
  const r = await fetch(url, opts);
  if (r.status === 401) {
    window.location.reload();
    return r;
  }
  return r;
}

interface StoreState {
  feeds: Feed[];
  articles: Article[];
  selectedView: View;
  selectedArticle: Article | null;
  loadingArticles: boolean;
  starredCount: number;

  init: () => Promise<void>;
  loadArticles: (view: View) => Promise<void>;
  selectView: (view: View) => void;
  search: (query: string) => void;
  selectArticle: (article: Article) => void;
  toggleStar: (article: Article) => void;
  addFeed: (input: { url: string }) => Promise<void>;
  importFeeds: (newFeeds: Feed[]) => void;
  deleteFeed: (feedId: string) => Promise<void>;
  updateFeed: (feedId: string, input: { name: string }) => Promise<void>;
}

export const useStore = create<StoreState>((set, get) => ({
  feeds: [],
  articles: [],
  selectedView: { type: 'today' },
  selectedArticle: null,
  loadingArticles: false,
  starredCount: 0,

  init: async () => {
    try {
      const [feedsData, starred] = await Promise.all([
        apiFetch(`${API}/feeds`).then((r) => r.json()),
        apiFetch(`${API}/starred/count`).then((r) => r.json()),
      ]);
      set({ feeds: feedsData, starredCount: starred.count ?? 0 });
    } catch (e) {
      console.error(e);
    }
  },

  loadArticles: async (view) => {
    if (loadAbortController) loadAbortController.abort();
    const controller = new AbortController();
    loadAbortController = controller;
    set({ loadingArticles: true, articles: [], selectedArticle: null });
    try {
      const urlMap: Record<string, string> = {
        all: `${API}/all-articles`,
        today: `${API}/today`,
        starred: `${API}/starred`,
      };
      const url =
        view.type === 'search'
          ? `${API}/search?q=${encodeURIComponent(view.query ?? '')}`
          : (urlMap[view.type] ?? `${API}/feeds/${view.feed?.id}/articles`);
      const data = await apiFetch(url, { signal: controller.signal }).then((r) => r.json());
      set({ articles: data.articles || [] });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') console.error(e);
    } finally {
      if (!controller.signal.aborted) set({ loadingArticles: false });
    }
  },

  selectView: (view) => {
    set({ selectedView: view });
    get().loadArticles(view);
  },

  search: (query) => {
    const q = query.trim();
    // Too short to be meaningful — fall back to the default view.
    if (q.length < 2) {
      get().selectView({ type: 'today' });
      return;
    }
    get().selectView({ type: 'search', query: q });
  },

  selectArticle: (article) => {
    apiFetch(`${API}/current-article`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ article }),
    }).catch(console.error);
    set({ selectedArticle: article });
  },

  toggleStar: (article) => {
    const newStarred = !article.isStarred;
    set((state) => ({
      articles: state.articles.map((a) =>
        a.id === article.id ? { ...a, isStarred: newStarred } : a,
      ),
      selectedArticle:
        state.selectedArticle?.id === article.id
          ? { ...state.selectedArticle, isStarred: newStarred }
          : state.selectedArticle,
      starredCount: newStarred ? state.starredCount + 1 : Math.max(0, state.starredCount - 1),
    }));
    apiFetch(`${API}/articles/star`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ article, starred: newStarred }),
    }).catch(console.error);
    if (get().selectedView.type === 'starred' && !newStarred) {
      set((state) => ({ articles: state.articles.filter((a) => a.id !== article.id) }));
    }
  },

  addFeed: async ({ url }) => {
    const r = await apiFetch(`${API}/feeds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '添加失败');
    set((state) => ({ feeds: [...state.feeds, data] }));
  },

  importFeeds: (newFeeds) => {
    set((state) => ({ feeds: [...state.feeds, ...newFeeds] }));
  },

  deleteFeed: async (feedId) => {
    await apiFetch(`${API}/feeds/${feedId}`, { method: 'DELETE' });
    const wasViewingDeleted =
      get().selectedView.type === 'feed' && get().selectedView.feed?.id === feedId;
    set((state) => ({ feeds: state.feeds.filter((f) => f.id !== feedId) }));
    if (wasViewingDeleted) {
      get().selectView({ type: 'all' });
    }
  },

  updateFeed: async (feedId, { name }) => {
    await apiFetch(`${API}/feeds/${feedId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    set((state) => ({ feeds: state.feeds.map((f) => (f.id === feedId ? { ...f, name } : f)) }));
  },
}));
