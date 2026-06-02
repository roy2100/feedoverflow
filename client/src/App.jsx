import { useState, useEffect, useRef, useMemo, lazy, Suspense } from 'react';
import { useStore } from './store';
import { AudioContext } from './AudioContext';
import { useIsMobile } from './hooks/useIsMobile';
import FeedSidebar from './components/FeedSidebar';
import ArticleList from './components/ArticleList';
import ArticleReader from './components/ArticleReader';
import FeedsPage from './pages/FeedsPage';
import ListPage from './pages/ListPage';
import ReaderPage from './pages/ReaderPage';

const AddFeedModal     = lazy(() => import('./components/AddFeedModal'));
const ManageFeedsModal = lazy(() => import('./components/ManageFeedsModal'));
const SettingsModal    = lazy(() => import('./components/SettingsModal'));
const PodcastPlayer    = lazy(() => import('./components/PodcastPlayer'));

export default function App() {
  const isMobile = useIsMobile();
  const [mobilePage, setMobilePage] = useState('feeds');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showManageModal, setShowManageModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [currentEpisode, setCurrentEpisode] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef(null);
  if (audioRef.current === null) audioRef.current = new Audio();

  const {
    feeds, articles, selectedView, selectedArticle, loadingArticles, starredCount, feedUnreadCounts,
    init, selectView, selectArticle, toggleStar, addFeed, importFeeds, deleteFeed, updateFeed, loadArticles, loadUnreadCounts,
  } = useStore();

  useEffect(() => {
    init();
    loadArticles({ type: 'today' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = setInterval(loadUnreadCounts, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [loadUnreadCounts]);

  useEffect(() => {
    const audio = audioRef.current;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
    };
  }, []);

  const handlePlay = (article) => {
    const audio = audioRef.current;
    if (currentEpisode?.id === article.id) {
      if (audio.paused) audio.play().catch(console.error);
      else audio.pause();
    } else {
      audio.src = article.audioUrl;
      audio.play().catch(console.error);
      setCurrentEpisode(article);
    }
  };

  const handleTogglePlay = () => {
    const audio = audioRef.current;
    if (audio.paused) audio.play().catch(console.error);
    else audio.pause();
  };

  const handleClosePlayer = () => {
    audioRef.current.pause();
    audioRef.current.src = '';
    setCurrentEpisode(null);
    setIsPlaying(false);
  };

  const audioCtx = {
    audioRef,
    currentEpisode,
    isPlaying,
    onPlay: handlePlay,
    onTogglePlay: handleTogglePlay,
    onClosePlayer: handleClosePlayer,
  };

  const unreadCount = useMemo(
    () => Object.values(feedUnreadCounts).reduce((s, n) => s + n, 0),
    [feedUnreadCounts]
  );
  const viewTitle =
    selectedView.type === 'all'     ? '全部未读' :
    selectedView.type === 'today'   ? '今日' :
    selectedView.type === 'starred' ? '已收藏' :
    selectedView.feed?.name;

  const addModal = showAddModal && (
    <Suspense fallback={null}>
      <AddFeedModal
        onClose={() => setShowAddModal(false)}
        onAdd={addFeed}
        onImport={importFeeds}
      />
    </Suspense>
  );

  if (isMobile) {
    const positions = {
      feeds:   { feeds: 'translateX(0)',     list: 'translateX(100%)',  article: 'translateX(100%)' },
      list:    { feeds: 'translateX(-100%)', list: 'translateX(0)',     article: 'translateX(100%)' },
      article: { feeds: 'translateX(-100%)', list: 'translateX(0)',     article: 'translateX(0)'   },
    };
    const tx = positions[mobilePage];
    const transition = 'transform 0.28s ease';

    return (
      <AudioContext.Provider value={audioCtx}>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', overflow: 'hidden', background: 'var(--bg)' }}>
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
            <div style={{ position: 'absolute', inset: 0, transform: tx.feeds, transition, willChange: 'transform' }}>
              <FeedsPage onOpenAddModal={() => setShowAddModal(true)} onNavigate={setMobilePage} />
            </div>
            <div style={{ position: 'absolute', inset: 0, transform: tx.list, transition, willChange: 'transform' }}>
              <ListPage onNavigate={setMobilePage} />
            </div>
            <div style={{ position: 'absolute', inset: 0, transform: tx.article, transition, willChange: 'transform', zIndex: 10 }}>
              <ReaderPage onNavigate={setMobilePage} />
            </div>
          </div>
          {currentEpisode && (
            <Suspense fallback={null}>
              <PodcastPlayer
                episode={currentEpisode}
                audioRef={audioRef}
                isPlaying={isPlaying}
                onTogglePlay={handleTogglePlay}
                onClose={handleClosePlayer}
              />
            </Suspense>
          )}
        </div>
        {addModal}
      </AudioContext.Provider>
    );
  }

  return (
    <AudioContext.Provider value={audioCtx}>
      <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg)' }}>
        <FeedSidebar
          feeds={feeds}
          selectedView={selectedView}
          onSelectView={selectView}
          unreadCount={unreadCount}
          starredCount={starredCount}
          feedUnreadCounts={feedUnreadCounts}
          onRefresh={() => loadArticles(selectedView)}
          onOpenAddModal={() => setShowAddModal(true)}
          onOpenManageModal={() => setShowManageModal(true)}
          onOpenSettings={() => setShowSettingsModal(true)}
        />
        <ArticleList
          articles={articles}
          selectedArticle={selectedArticle}
          onSelectArticle={selectArticle}
          loading={loadingArticles}
          viewTitle={viewTitle}
          onRefresh={() => loadArticles(selectedView)}
          onPlay={handlePlay}
          currentEpisode={currentEpisode}
          isPlaying={isPlaying}
        />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
          <ArticleReader
            article={selectedArticle}
            onToggleStar={toggleStar}
            onPlay={handlePlay}
            currentEpisode={currentEpisode}
            isPlaying={isPlaying}
          />
          {currentEpisode && (
            <Suspense fallback={null}>
              <PodcastPlayer
                episode={currentEpisode}
                audioRef={audioRef}
                isPlaying={isPlaying}
                onTogglePlay={handleTogglePlay}
                onClose={handleClosePlayer}
              />
            </Suspense>
          )}
        </div>
        {addModal}
        {showManageModal && (
          <Suspense fallback={null}>
            <ManageFeedsModal
              feeds={feeds}
              onClose={() => setShowManageModal(false)}
              onDelete={deleteFeed}
              onUpdate={updateFeed}
            />
          </Suspense>
        )}
        {showSettingsModal && (
          <Suspense fallback={null}>
            <SettingsModal onClose={() => setShowSettingsModal(false)} />
          </Suspense>
        )}
      </div>
    </AudioContext.Provider>
  );
}
