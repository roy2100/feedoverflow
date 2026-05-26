import { useState, useEffect, useCallback } from 'react';
import FeedSidebar from './components/FeedSidebar';
import ArticleList from './components/ArticleList';
import ArticleReader from './components/ArticleReader';
import AddFeedModal from './components/AddFeedModal';

const API = '/api';

export default function App() {
  const [showAddModal, setShowAddModal] = useState(false);
  const [feeds, setFeeds] = useState([]);
  const [selectedView, setSelectedView] = useState({ type: 'all' });
  const [articles, setArticles] = useState([]);
  const [selectedArticle, setSelectedArticle] = useState(null);
  const [loadingArticles, setLoadingArticles] = useState(false);
  const [starredCount, setStarredCount] = useState(0);

  useEffect(() => {
    fetch(`${API}/feeds`).then(r => r.json()).then(setFeeds).catch(console.error);
    fetch(`${API}/starred/count`).then(r => r.json()).then(d => setStarredCount(d.count || 0)).catch(console.error);
  }, []);

  const loadArticles = useCallback(async (view) => {
    setSelectedArticle(null);
    setLoadingArticles(true);
    setArticles([]);
    try {
      const urlMap = { all: `${API}/all-articles`, today: `${API}/today`, starred: `${API}/starred` };
      const url = urlMap[view.type] ?? `${API}/feeds/${view.feed.id}/articles`;
      const data = await fetch(url).then(r => r.json());
      setArticles(data.articles || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingArticles(false);
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

  const handleAddFeed = useCallback(async ({ url, name, category }) => {
    const r = await fetch(`${API}/feeds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, name, category }),
    });
    const newFeed = await r.json();
    setFeeds(prev => [...prev, newFeed]);
  }, []);

  const handleDeleteFeed = useCallback(async (feedId) => {
    await fetch(`${API}/feeds/${feedId}`, { method: 'DELETE' });
    setFeeds(prev => prev.filter(f => f.id !== feedId));
    if (selectedView.type === 'feed' && selectedView.feed.id === feedId) {
      setSelectedView({ type: 'all' });
    }
  }, [selectedView]);

  const unreadCount = articles.filter(a => !a.isRead).length;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg)' }}>
      <FeedSidebar
        feeds={feeds}
        selectedView={selectedView}
        onSelectView={setSelectedView}
        onDeleteFeed={handleDeleteFeed}
        unreadCount={unreadCount}
        starredCount={starredCount}
        onRefresh={() => loadArticles(selectedView)}
        onOpenAddModal={() => setShowAddModal(true)}
      />
      <ArticleList
        articles={articles}
        selectedArticle={selectedArticle}
        onSelectArticle={handleSelectArticle}
        onToggleStar={handleToggleStar}
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
    </div>
  );
}
