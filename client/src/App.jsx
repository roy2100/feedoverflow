import { useState, useEffect, useCallback, useRef } from 'react';
import FeedSidebar from './components/FeedSidebar';
import ArticleList from './components/ArticleList';
import ArticleReader from './components/ArticleReader';
import AddFeedModal from './components/AddFeedModal';
import ManageFeedsModal from './components/ManageFeedsModal';
import SettingsModal from './components/SettingsModal';

const API = '/api';

export default function App() {
  const [showAddModal, setShowAddModal] = useState(false);
  const [showManageModal, setShowManageModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [feeds, setFeeds] = useState([]);
  const [selectedView, setSelectedView] = useState({ type: 'today' });
  const [articles, setArticles] = useState([]);
  const [selectedArticle, setSelectedArticle] = useState(null);
  const [loadingArticles, setLoadingArticles] = useState(false);
  const [starredCount, setStarredCount] = useState(0);

  useEffect(() => {
    fetch(`${API}/feeds`).then(r => r.json()).then(setFeeds).catch(console.error);
    fetch(`${API}/starred/count`).then(r => r.json()).then(d => setStarredCount(d.count || 0)).catch(console.error);
  }, []);

  const loadAbortRef = useRef(null);

  const loadArticles = useCallback(async (view) => {
    if (loadAbortRef.current) loadAbortRef.current.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;

    setSelectedArticle(null);
    setLoadingArticles(true);
    setArticles([]);
    try {
      const urlMap = { all: `${API}/all-articles`, today: `${API}/today`, starred: `${API}/starred` };
      const url = urlMap[view.type] ?? `${API}/feeds/${view.feed.id}/articles`;
      const data = await fetch(url, { signal: controller.signal }).then(r => r.json());
      setArticles(data.articles || []);
    } catch (e) {
      if (e.name !== 'AbortError') console.error(e);
    } finally {
      if (!controller.signal.aborted) setLoadingArticles(false);
    }
  }, []);

  useEffect(() => { loadArticles(selectedView); }, [selectedView, loadArticles]);

  const handleSelectArticle = useCallback((article) => {
    setSelectedArticle(article);
    if (article.isRead) return;
    // Optimistic update
    setArticles(prev => prev.map(a => a.id === article.id ? { ...a, isRead: true } : a));
    setSelectedArticle(a => a ? { ...a, isRead: true } : a);
    fetch(`${API}/articles/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ article }),
    }).catch(console.error);
  }, []);

  const handleToggleStar = useCallback((article) => {
    const newStarred = !article.isStarred;
    // Optimistic update
    setArticles(prev => prev.map(a => a.id === article.id ? { ...a, isStarred: newStarred } : a));
    setSelectedArticle(prev => prev?.id === article.id ? { ...prev, isStarred: newStarred } : prev);
    setStarredCount(n => Math.max(0, n + (newStarred ? 1 : -1)));
    fetch(`${API}/articles/star`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ article, starred: newStarred }),
    }).catch(console.error);
    // If in starred view, refresh list
    if (selectedView.type === 'starred' && !newStarred) {
      setArticles(prev => prev.filter(a => a.id !== article.id));
    }
  }, [selectedView]);

  const handleAddFeed = useCallback(async ({ url }) => {
    const r = await fetch(`${API}/feeds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '添加失败');
    setFeeds(prev => [...prev, data]);
  }, []);

  const handleDeleteFeed = useCallback(async (feedId) => {
    await fetch(`${API}/feeds/${feedId}`, { method: 'DELETE' });
    setFeeds(prev => prev.filter(f => f.id !== feedId));
    if (selectedView.type === 'feed' && selectedView.feed.id === feedId) {
      setSelectedView({ type: 'all' });
    }
  }, [selectedView]);

  const handleUpdateFeed = useCallback(async (feedId, { name }) => {
    await fetch(`${API}/feeds/${feedId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    setFeeds(prev => prev.map(f => f.id === feedId ? { ...f, name } : f));
  }, []);

  const unreadCount = articles.filter(a => !a.isRead).length;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg)' }}>
      <FeedSidebar
        feeds={feeds}
        selectedView={selectedView}
        onSelectView={setSelectedView}
        unreadCount={unreadCount}
        starredCount={starredCount}
        onRefresh={() => loadArticles(selectedView)}
        onOpenAddModal={() => setShowAddModal(true)}
        onOpenManageModal={() => setShowManageModal(true)}
        onOpenSettings={() => setShowSettingsModal(true)}
      />
      <ArticleList
        articles={articles}
        selectedArticle={selectedArticle}
        onSelectArticle={handleSelectArticle}
        loading={loadingArticles}
        viewTitle={
          selectedView.type === 'all'     ? '全部未读' :
          selectedView.type === 'today'   ? '今日' :
          selectedView.type === 'starred' ? '已收藏' :
          selectedView.feed?.name
        }
        onRefresh={() => loadArticles(selectedView)}
      />
      <ArticleReader article={selectedArticle} onToggleStar={handleToggleStar} />
      {showAddModal && (
        <AddFeedModal
          onClose={() => setShowAddModal(false)}
          onAdd={handleAddFeed}
          onImport={(newFeeds) => setFeeds(prev => [...prev, ...newFeeds])}
        />
      )}
      {showManageModal && (
        <ManageFeedsModal
          feeds={feeds}
          onClose={() => setShowManageModal(false)}
          onDelete={handleDeleteFeed}
          onUpdate={handleUpdateFeed}
        />
      )}
      {showSettingsModal && (
        <SettingsModal onClose={() => setShowSettingsModal(false)} />
      )}
    </div>
  );
}
