import { create } from 'zustand';

const API = '/api';
let loadAbortController = null;

async function apiFetch(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401) {
    window.location.reload();
    return r;
  }
  return r;
}

export const useStore = create((set, get) => ({
  feeds: [],
  articles: [],
  selectedView: { type: 'today' },
  selectedArticle: null,
  loadingArticles: false,

  init: async () => {
    try {
      const feedsData = await apiFetch(`${API}/feeds`).then((r) => r.json());
      set({ feeds: feedsData });
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
      const urlMap = {
        all: `${API}/all-articles`,
        today: `${API}/today`,
        starred: `${API}/starred`,
      };
      const url = urlMap[view.type] ?? `${API}/feeds/${view.feed.id}/articles`;
      const data = await apiFetch(url, { signal: controller.signal }).then((r) => r.json());
      set({ articles: data.articles || [] });
    } catch (e) {
      if (e.name !== 'AbortError') console.error(e);
    } finally {
      if (!controller.signal.aborted) set({ loadingArticles: false });
    }
  },

  selectView: (view) => {
    set({ selectedView: view });
    get().loadArticles(view);
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
