import { useState, useEffect, useCallback } from 'react';
import FeedSidebar from './components/FeedSidebar';
import ArticleList from './components/ArticleList';
import ArticleReader from './components/ArticleReader';
import AddFeedModal from './components/AddFeedModal';

const API = '/api';

export default function App() {
  const [showAddModal, setShowAddModal] = useState(false);
  const [feeds, setFeeds] = useState([]);
  const [selectedView, setSelectedView] = useState({ type: 'all' }); // {type:'all'} | {type:'feed', feed}
  const [articles, setArticles] = useState([]);
  const [selectedArticle, setSelectedArticle] = useState(null);
  const [loadingArticles, setLoadingArticles] = useState(false);
  const [readSet, setReadSet] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('rss_read') || '[]')); }
    catch { return new Set(); }
  });

  useEffect(() => {
    fetch(`${API}/feeds`)
      .then(r => r.json())
      .then(setFeeds)
      .catch(console.error);
  }, []);

  const persistRead = useCallback((set) => {
    localStorage.setItem('rss_read', JSON.stringify([...set]));
  }, []);

  const loadArticles = useCallback(async (view) => {
    setSelectedArticle(null);
    setLoadingArticles(true);
    setArticles([]);
    try {
      let data;
      if (view.type === 'all') {
        const r = await fetch(`${API}/all-articles`);
        data = await r.json();
        setArticles(data.articles || []);
      } else {
        const r = await fetch(`${API}/feeds/${view.feed.id}/articles`);
        data = await r.json();
        setArticles(data.articles || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingArticles(false);
    }
  }, []);

  useEffect(() => {
    loadArticles(selectedView);
  }, [selectedView, loadArticles]);

  const markRead = useCallback((articleId) => {
    setReadSet(prev => {
      const next = new Set(prev);
      next.add(articleId);
      persistRead(next);
      return next;
    });
  }, [persistRead]);

  const handleSelectArticle = useCallback((article) => {
    setSelectedArticle(article);
    markRead(article.id);
  }, [markRead]);

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

  const unreadCount = articles.filter(a => !readSet.has(a.id)).length;

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      overflow: 'hidden',
      background: 'var(--bg)',
    }}>
      <FeedSidebar
        feeds={feeds}
        selectedView={selectedView}
        onSelectView={setSelectedView}
        onDeleteFeed={handleDeleteFeed}
        totalUnread={unreadCount}
        onRefresh={() => loadArticles(selectedView)}
        onOpenAddModal={() => setShowAddModal(true)}
      />
      {showAddModal && (
        <AddFeedModal
          onClose={() => setShowAddModal(false)}
          onAdd={handleAddFeed}
        />
      )}
      <ArticleList
        articles={articles}
        selectedArticle={selectedArticle}
        onSelectArticle={handleSelectArticle}
        loading={loadingArticles}
        readSet={readSet}
        viewTitle={selectedView.type === 'all' ? '全部未读' : selectedView.feed?.name}
        onRefresh={() => loadArticles(selectedView)}
      />
      <ArticleReader article={selectedArticle} />
    </div>
  );
}
