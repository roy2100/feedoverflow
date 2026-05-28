import { useState, useEffect, useRef } from 'react';
import { useStore } from './store';
import { AudioContext } from './AudioContext';
import { useIsMobile } from './hooks/useIsMobile';
import FeedSidebar from './components/FeedSidebar';
import ArticleList from './components/ArticleList';
import ArticleReader from './components/ArticleReader';
import AddFeedModal from './components/AddFeedModal';
import ManageFeedsModal from './components/ManageFeedsModal';
import SettingsModal from './components/SettingsModal';
import PodcastPlayer from './components/PodcastPlayer';
import FeedsPage from './pages/FeedsPage';
import ListPage from './pages/ListPage';
import ReaderPage from './pages/ReaderPage';

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
    feeds, articles, selectedView, selectedArticle, loadingArticles, starredCount,
    init, selectView, selectArticle, toggleStar, addFeed, importFeeds, deleteFeed, updateFeed, loadArticles,
  } = useStore();

  useEffect(() => {
    init();
    loadArticles({ type: 'today' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const unreadCount = articles.filter(a => !a.isRead).length;
  const viewTitle =
    selectedView.type === 'all'     ? '全部未读' :
    selectedView.type === 'today'   ? '今日' :
    selectedView.type === 'starred' ? '已收藏' :
    selectedView.feed?.name;

  const addModal = showAddModal && (
    <AddFeedModal
      onClose={() => setShowAddModal(false)}
      onAdd={addFeed}
      onImport={importFeeds}
    />
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
            <PodcastPlayer
              episode={currentEpisode}
              audioRef={audioRef}
              isPlaying={isPlaying}
              onTogglePlay={handleTogglePlay}
              onClose={handleClosePlayer}
            />
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
            <PodcastPlayer
              episode={currentEpisode}
              audioRef={audioRef}
              isPlaying={isPlaying}
              onTogglePlay={handleTogglePlay}
              onClose={handleClosePlayer}
            />
          )}
        </div>
        {addModal}
        {showManageModal && (
          <ManageFeedsModal
            feeds={feeds}
            onClose={() => setShowManageModal(false)}
            onDelete={deleteFeed}
            onUpdate={updateFeed}
          />
        )}
        {showSettingsModal && (
          <SettingsModal onClose={() => setShowSettingsModal(false)} />
        )}
      </div>
    </AudioContext.Provider>
  );
}
