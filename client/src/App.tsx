import { useState, useEffect, useRef, lazy, Suspense } from 'react';

import { AudioContext } from './AudioContext';
import ArticleList from './components/ArticleList';
import ArticleReader from './components/ArticleReader';
import FeedSidebar from './components/FeedSidebar';
import LoginForm from './components/LoginForm';
import { useIsMobile } from './hooks/useIsMobile';
import FeedsPage from './pages/FeedsPage';
import ListPage from './pages/ListPage';
import ReaderPage from './pages/ReaderPage';
import { useStore } from './store';
import type { AudioCtxValue, Article, MobilePage } from './types';

const AddFeedModal = lazy(() => import('./components/AddFeedModal'));
const ManageFeedsModal = lazy(() => import('./components/ManageFeedsModal'));
const SettingsModal = lazy(() => import('./components/SettingsModal'));
const PodcastPlayer = lazy(() => import('./components/PodcastPlayer'));

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null); // null=checking, false=unauthed, true=authed
  const isMobile = useIsMobile();
  const [mobilePage, setMobilePage] = useState<MobilePage>('feeds');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showManageModal, setShowManageModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [readingMode, setReadingMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('sidebar-collapsed') === '1',
  );
  const [currentEpisode, setCurrentEpisode] = useState<Article | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  if (audioRef.current === null) audioRef.current = new Audio();
  const readerRef = useRef<HTMLDivElement>(null);

  const {
    feeds,
    articles,
    selectedView,
    selectedArticle,
    loadingArticles,
    init,
    selectView,
    search,
    selectArticle,
    toggleStar,
    addFeed,
    importFeeds,
    deleteFeed,
    updateFeed,
    loadArticles,
    lastListView,
    scopedSearch,
    toggleSearchScope,
  } = useStore();

  // Label for the scopable base view (Starred / a feed). Null ⇒ not scopable ⇒ no toggle.
  const scopeLabel =
    lastListView.type === 'starred'
      ? 'Starred'
      : lastListView.type === 'feed'
        ? (lastListView.feed?.name ?? null)
        : null;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isMobile) return;
      if (showAddModal || showManageModal || showSettingsModal) return;
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable)
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        if (readingMode) {
          e.preventDefault();
          setReadingMode(false);
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const idx = articles.findIndex((a) => a.id === selectedArticle?.id);
        const next = idx === -1 ? articles[0] : articles[idx + 1];
        if (next) selectArticle(next);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = articles.findIndex((a) => a.id === selectedArticle?.id);
        if (idx > 0) selectArticle(articles[idx - 1]);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [
    articles,
    selectedArticle,
    showAddModal,
    showManageModal,
    showSettingsModal,
    isMobile,
    selectArticle,
    readingMode,
  ]);

  // Never leave the reader stuck fullscreen with nothing to show
  useEffect(() => {
    if (!selectedArticle) setReadingMode(false);
  }, [selectedArticle]);

  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  const toggleSidebar = () => setSidebarCollapsed((v) => !v);

  useEffect(() => {
    readerRef.current?.focus({ preventScroll: true });
  }, [selectedArticle?.id]);

  useEffect(() => {
    fetch('/api/auth-check')
      .then((r) => r.json())
      .then((data) => {
        setAuthed(data.authed);
        if (data.authed) {
          init();
          loadArticles({ type: 'today' });
        }
      })
      .catch(() => {
        setAuthed(true);
        init();
        loadArticles({ type: 'today' });
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
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

  const handlePlay = (article: Article) => {
    const audio = audioRef.current;
    if (!audio) return;
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
    if (!audio) return;
    if (audio.paused) audio.play().catch(console.error);
    else audio.pause();
  };

  const handleClosePlayer = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = '';
    }
    setCurrentEpisode(null);
    setIsPlaying(false);
  };

  const audioCtx: AudioCtxValue = {
    audioRef,
    currentEpisode,
    isPlaying,
    onPlay: handlePlay,
    onTogglePlay: handleTogglePlay,
    onClosePlayer: handleClosePlayer,
  };

  const viewTitle =
    selectedView.type === 'all'
      ? '全部'
      : selectedView.type === 'today'
        ? '今日'
        : selectedView.type === 'starred'
          ? '收藏'
          : selectedView.type === 'podcast'
            ? '播客'
            : selectedView.type === 'search'
              ? `搜索：${selectedView.query ?? ''}`
              : selectedView.feed?.name;

  const addModal = showAddModal && (
    <Suspense fallback={null}>
      <AddFeedModal onClose={() => setShowAddModal(false)} onAdd={addFeed} onImport={importFeeds} />
    </Suspense>
  );

  if (authed === null) return <div style={{ height: '100dvh', background: 'var(--bg)' }} />;
  if (authed === false)
    return (
      <LoginForm
        onLogin={() => {
          setAuthed(true);
          init();
          loadArticles({ type: 'today' });
        }}
      />
    );

  if (isMobile) {
    const positions: Record<MobilePage, { feeds: string; list: string; article: string }> = {
      feeds: { feeds: 'translateX(0)', list: 'translateX(100%)', article: 'translateX(100%)' },
      list: { feeds: 'translateX(-100%)', list: 'translateX(0)', article: 'translateX(100%)' },
      article: { feeds: 'translateX(-100%)', list: 'translateX(0)', article: 'translateX(0)' },
    };
    const tx = positions[mobilePage];
    const transition = 'transform 0.28s ease';

    return (
      <AudioContext.Provider value={audioCtx}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100dvh',
            overflow: 'hidden',
            background: 'var(--bg)',
          }}
        >
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                transform: tx.feeds,
                transition,
                willChange: 'transform',
              }}
            >
              <FeedsPage onOpenAddModal={() => setShowAddModal(true)} onNavigate={setMobilePage} />
            </div>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                transform: tx.list,
                transition,
                willChange: 'transform',
              }}
            >
              <ListPage onNavigate={setMobilePage} />
            </div>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                transform: tx.article,
                transition,
                willChange: 'transform',
                zIndex: 10,
              }}
            >
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
      <div
        style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg)' }}
      >
        {!readingMode && !sidebarCollapsed && (
          <FeedSidebar
            feeds={feeds}
            selectedView={selectedView}
            onSelectView={selectView}
            onRefresh={() => loadArticles(selectedView)}
            onToggleSidebar={toggleSidebar}
            onOpenAddModal={() => setShowAddModal(true)}
            onOpenManageModal={() => setShowManageModal(true)}
            onOpenSettings={() => setShowSettingsModal(true)}
            onSearch={search}
            scopedSearch={scopedSearch}
            scopeLabel={scopeLabel}
            onToggleSearchScope={toggleSearchScope}
          />
        )}
        {!readingMode && (
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
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            hideFeedName={selectedView.type === 'feed'}
          />
        )}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          <ArticleReader
            article={selectedArticle}
            onToggleStar={toggleStar}
            onPlay={handlePlay}
            currentEpisode={currentEpisode}
            isPlaying={isPlaying}
            scrollRef={readerRef}
            readingMode={readingMode}
            onToggleReadingMode={() => setReadingMode((v) => !v)}
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
