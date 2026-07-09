import { create } from 'zustand';

import type { Article, Feed, ListMode, SearchScope, View } from './types';

const API = '/api';
let loadAbortController: AbortController | null = null;

// A base view is "scopable" only when it maps to a pure SQL filter: Starred or a single feed.
// 全部/All and Today are not scopable (All would be a no-op; Today needs date logic).
function scopeFromView(view: View): SearchScope | undefined {
  if (view.type === 'starred') return { kind: 'starred' };
  if (view.type === 'feed' && view.feed) {
    return { kind: 'feed', feedId: view.feed.id, feedName: view.feed.name };
  }
  return undefined;
}

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
  // The most recent non-search view — the base whose scope search can restrict to.
  lastListView: View;
  // Whether scoped search is enabled (desktop toggle). Only effective when lastListView is scopable.
  scopedSearch: boolean;
  // Ordering for the merged 全部/今日 lists. Only those two views send it to the server.
  listMode: ListMode;

  init: () => Promise<void>;
  loadArticles: (view: View) => Promise<void>;
  selectView: (view: View) => void;
  search: (query: string) => void;
  toggleSearchScope: () => void;
  setListMode: (mode: ListMode) => void;
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
  lastListView: { type: 'today' },
  scopedSearch: false,
  listMode: localStorage.getItem('list-mode') === 'digest' ? 'digest' : 'latest',

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
        podcast: `${API}/podcasts`,
      };
      let url: string;
      if (view.type === 'search') {
        url = `${API}/search?q=${encodeURIComponent(view.query ?? '')}`;
        if (view.scope?.kind === 'starred') url += '&scope=starred';
        else if (view.scope?.kind === 'feed' && view.scope.feedId) {
          url += `&scope=feed&feedId=${encodeURIComponent(view.scope.feedId)}`;
        }
      } else {
        url = urlMap[view.type] ?? `${API}/feeds/${view.feed?.id}/articles`;
        // 全部/今日 honor the latest/digest ordering toggle; other views ignore it.
        if (view.type === 'all' || view.type === 'today') {
          url += `?mode=${get().listMode}`;
        }
      }
      const data = await apiFetch(url, { signal: controller.signal }).then((r) => r.json());
      set({ articles: data.articles || [] });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') console.error(e);
    } finally {
      if (!controller.signal.aborted) set({ loadingArticles: false });
    }
  },

  selectView: (view) => {
    // Remember the last real list view so search can scope to it later.
    if (view.type !== 'search') set({ lastListView: view });
    set({ selectedView: view });
    get().loadArticles(view);
  },

  search: (query) => {
    const q = query.trim();
    if (!q) {
      get().selectView(get().lastListView);
      return;
    }
    const scope = get().scopedSearch ? scopeFromView(get().lastListView) : undefined;
    set({ selectedView: { type: 'search', query: q, scope } });
    get().loadArticles({ type: 'search', query: q, scope });
  },

  toggleSearchScope: () => {
    const next = !get().scopedSearch;
    set({ scopedSearch: next });
    // Re-run the active search so results update immediately.
    const view = get().selectedView;
    if (view.type === 'search' && (view.query?.trim().length ?? 0) > 0) {
      get().search(view.query ?? '');
    }
  },

  setListMode: (mode) => {
    if (get().listMode === mode) return;
    localStorage.setItem('list-mode', mode);
    set({ listMode: mode });
    // Re-fetch only when the active list actually honors the mode.
    const view = get().selectedView;
    if (view.type === 'all' || view.type === 'today') get().loadArticles(view);
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
