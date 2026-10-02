import { useAudio } from '../AudioContext';
import ArticleDeck from '../components/ArticleDeck';
import ArticleList from '../components/ArticleList';
import TrendChart from '../components/TrendChart';
import { useStore } from '../store';
import type { Article, MobilePage } from '../types';
import { emptyTextOf, searchTabOf, viewTitle } from '../viewTitle';

interface ListPageProps {
  onNavigate: (page: MobilePage) => void;
  // Whether this panel is the one on screen (the deck re-pins its scroll on return).
  active: boolean;
}

export default function ListPage({ onNavigate, active }: ListPageProps) {
  const {
    articles,
    selectedView,
    selectedArticle,
    loadingArticles,
    selectArticle,
    loadArticles,
    listMode,
    setListMode,
    setSearchTab,
    presentation,
    setPresentation,
    toggleStar,
  } = useStore();
  const { currentEpisode, isPlaying, isBuffering, onPlay } = useAudio();

  const handleSelectArticle = (article: Article) => {
    selectArticle(article);
    onNavigate('article');
  };

  // 趋势 keeps rows: its chart is the point of that view, and a deck has no room for it.
  const deckable = selectedView.type !== 'trend';

  if (presentation === 'deck' && deckable) {
    return (
      <ArticleDeck
        articles={articles}
        loading={loadingArticles}
        viewTitle={viewTitle(selectedView)}
        emptyText={emptyTextOf(selectedView)}
        active={active}
        hideFeedName={selectedView.type === 'feed'}
        onBack={() => onNavigate('feeds')}
        onShowRows={() => setPresentation('rows')}
        onOpen={handleSelectArticle}
        onToggleStar={toggleStar}
        onRefresh={() => loadArticles(selectedView)}
        onPlay={onPlay}
        currentEpisode={currentEpisode}
        isPlaying={isPlaying}
        isBuffering={isBuffering}
      />
    );
  }

  return (
    <ArticleList
      isMobile
      onBack={() => onNavigate('feeds')}
      articles={articles}
      selectedArticle={selectedArticle}
      onSelectArticle={handleSelectArticle}
      loading={loadingArticles}
      viewTitle={viewTitle(selectedView)}
      onRefresh={() => loadArticles(selectedView)}
      onPlay={onPlay}
      currentEpisode={currentEpisode}
      isPlaying={isPlaying}
      isBuffering={isBuffering}
      hideFeedName={selectedView.type === 'feed'}
      showModeToggle={selectedView.type === 'all' || selectedView.type === 'today'}
      listMode={listMode}
      onSetListMode={setListMode}
      searchTab={searchTabOf(selectedView)}
      onSetSearchTab={setSearchTab}
      topSlot={selectedView.type === 'trend' ? <TrendChart /> : undefined}
      emptyText={emptyTextOf(selectedView)}
      onShowDeck={deckable ? () => setPresentation('deck') : undefined}
    />
  );
}
