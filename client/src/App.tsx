import { useState, useEffect, useRef, lazy, Suspense, type ReactNode } from 'react';

import { AudioContext } from './AudioContext';
import ArticleList from './components/ArticleList';
import ArticleReader from './components/ArticleReader';
import FeedSidebar from './components/FeedSidebar';
import LoginForm from './components/LoginForm';
import { useIsMobile } from './hooks/useIsMobile';
import { PANEL_DEPTH, useMobilePanelHistory } from './hooks/useMobilePanelHistory';
import FeedsPage from './pages/FeedsPage';
import ListPage from './pages/ListPage';
import ReaderPage from './pages/ReaderPage';
import { useStore } from './store';
import type { AudioCtxValue, Article } from './types';

const AddFeedModal = lazy(() => import('./components/AddFeedModal'));
const ManageFeedsModal = lazy(() => import('./components/ManageFeedsModal'));
const SettingsModal = lazy(() => import('./components/SettingsModal'));
const PodcastPlayer = lazy(() => import('./components/PodcastPlayer'));

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null); // null=checking, false=unauthed, true=authed
  const isMobile = useIsMobile();
  const {
    page: mobilePage,
    instant: instantPanel,
    navigate: navigateMobile,
    openDeepLinked,
  } = useMobilePanelHistory(isMobile);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showManageModal, setShowManageModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [readingMode, setReadingMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('sidebar-collapsed') === '1',
  );
  // Article id handed over by a push notification, awaiting the feed list.
  const [pendingArticleId, setPendingArticleId] = useState<string | null>(null);
  const [currentEpisode, setCurrentEpisode] = useState<Article | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
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
    fetchArticleById,
    toggleStar,
    addFeed,
    importFeeds,
    deleteFeed,
    updateFeed,
    loadArticles,
    lastListView,
    scopedSearch,
    toggleSearchScope,
    listMode,
    setListMode,
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

  // Push deep link. A notification names one article, and it is usually not in
  // whatever list the app has loaded, so it is fetched by id. Two arrival paths:
  // `?article=<id>` when the tap cold-started the app, and a service-worker
  // message when a window was already open (see client/public/push-sw.js —
  // messaging rather than navigating keeps podcast playback and scroll alive).
  // Nothing in the normal browsing path runs through here.
  // Capture the id both arrival paths carry, then open it in a second step: the
  // feed list is still loading during a cold start, and opening immediately
  // would miss the lookup on exactly the path this exists for.
  useEffect(() => {
    if (authed !== true) return;

    const params = new URLSearchParams(window.location.search);
    const initial = params.get('article');
    if (initial) {
      // Strip the param straight away: leaving it would re-open the article on
      // every reload, and it would follow anything the user bookmarks or shares.
      params.delete('article');
      const rest = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
      setPendingArticleId(initial);
    }

    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; id?: unknown } | null;
      if (data?.type === 'open-article' && typeof data.id === 'string')
        setPendingArticleId(data.id);
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, [authed]);

  useEffect(() => {
    // Wait for feeds: without them the article's own feed can't be resolved, and
    // back would fall through to whatever list happened to be loaded. A user with
    // no feeds can't receive a push in the first place, so this never stalls.
    if (!pendingArticleId || feeds.length === 0) return;
    const id = pendingArticleId;
    setPendingArticleId(null);
    void (async () => {
      const article = await fetchArticleById(id);
      if (!article) return;
      // Synthesize the path the user never walked: put the article's own feed
      // behind the reader, so back lands where the article actually came from.
      // The web equivalent of Android's TaskStackBuilder parent stack / iOS's
      // setViewControllers on a deep link.
      const feed = feeds.find((f) => f.id === article.feedId);
      if (feed) selectView({ type: 'feed', feed });
      // Must follow selectView: loadArticles clears selectedArticle as it starts.
      selectArticle(article);
      openDeepLinked();
    })();
  }, [pendingArticleId, feeds]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => {
      setIsPlaying(false);
      setIsBuffering(false);
    };
    const onEnded = () => {
      setIsPlaying(false);
      setIsBuffering(false);
    };
    // `waiting` fires while audio stalls to buffer; `playing` fires once real
    // playback (sound) begins — the gap between them is the blank-audio wait.
    const onWaiting = () => setIsBuffering(true);
    const onPlaying = () => setIsBuffering(false);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('playing', onPlaying);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('playing', onPlaying);
    };
  }, []);

  const handlePlay = (article: Article) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (currentEpisode?.id === article.id) {
      if (audio.paused) {
        setIsBuffering(true);
        audio.play().catch(console.error);
      } else {
        audio.pause();
      }
    } else {
      audio.src = article.audioUrl;
      setIsBuffering(true);
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
    setIsBuffering(false);
  };

  const audioCtx: AudioCtxValue = {
    audioRef,
    currentEpisode,
    isPlaying,
    isBuffering,
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

  // Shared by both layouts: 管理订阅源 is also the only place to switch a feed's
  // update notifications on, and phones are where those matter most.
  const manageModal = showManageModal && (
    <Suspense fallback={null}>
      <ManageFeedsModal
        feeds={feeds}
        onClose={() => setShowManageModal(false)}
        onDelete={deleteFeed}
        onUpdate={updateFeed}
      />
    </Suspense>
  );

  if (authed === null)
    return <div style={{ height: 'var(--app-height, 100dvh)', background: 'var(--bg)' }} />;
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
    const depth = PANEL_DEPTH[mobilePage];
    // instantPanel: this change came from an iOS swipe-back, which already
    // animated the navigation — run no CSS slide so the two don't fight.
    const transition = instantPanel ? 'none' : 'transform 0.28s cubic-bezier(0.4, 0, 0.2, 1)';

    // Every panel stays mounted; translateX drives visibility. A parent panel
    // (rel < 0) parallax-shifts left and dims behind the active panel, adding
    // depth during the slide without extra DOM layers. z-index = idx + 1 keeps
    // deeper panels above shallower ones so both push and pop read correctly.
    const panel = (idx: number, content: ReactNode) => {
      const rel = idx - depth;
      const tx = rel < 0 ? 'translateX(-25%)' : rel === 0 ? 'translateX(0)' : 'translateX(100%)';
      return (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            transform: tx,
            transition,
            willChange: 'transform',
            zIndex: idx + 1,
          }}
        >
          {content}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(28, 25, 23, 0.28)',
              pointerEvents: 'none',
              opacity: rel < 0 ? 1 : 0,
              transition: instantPanel ? 'none' : 'opacity 0.28s ease',
            }}
          />
        </div>
      );
    };

    return (
      <AudioContext.Provider value={audioCtx}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: 'var(--app-height, 100dvh)',
            overflow: 'hidden',
            background: 'var(--bg)',
          }}
        >
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
            {panel(
              0,
              <FeedsPage
                onOpenAddModal={() => setShowAddModal(true)}
                onOpenManageModal={() => setShowManageModal(true)}
                onNavigate={navigateMobile}
              />,
            )}
            {panel(1, <ListPage onNavigate={navigateMobile} />)}
            {panel(2, <ReaderPage onNavigate={navigateMobile} />)}
          </div>
          {currentEpisode && (
            <Suspense fallback={null}>
              <PodcastPlayer
                episode={currentEpisode}
                audioRef={audioRef}
                isPlaying={isPlaying}
                isBuffering={isBuffering}
                onTogglePlay={handleTogglePlay}
                onClose={handleClosePlayer}
              />
            </Suspense>
          )}
        </div>
        {addModal}
        {manageModal}
      </AudioContext.Provider>
    );
  }

  return (
    <AudioContext.Provider value={audioCtx}>
      <div
        style={{
          display: 'flex',
          height: 'var(--app-height, 100vh)',
          overflow: 'hidden',
          background: 'var(--bg)',
        }}
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
            isBuffering={isBuffering}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            hideFeedName={selectedView.type === 'feed'}
            showModeToggle={selectedView.type === 'all' || selectedView.type === 'today'}
            listMode={listMode}
            onSetListMode={setListMode}
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
            isBuffering={isBuffering}
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
                isBuffering={isBuffering}
                onTogglePlay={handleTogglePlay}
                onClose={handleClosePlayer}
              />
            </Suspense>
          )}
        </div>
        {addModal}
        {manageModal}
        {showSettingsModal && (
          <Suspense fallback={null}>
            <SettingsModal onClose={() => setShowSettingsModal(false)} />
          </Suspense>
        )}
      </div>
    </AudioContext.Provider>
  );
}
