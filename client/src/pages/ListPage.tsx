import { useAudio } from '../AudioContext';
import ArticleList from '../components/ArticleList';
import { useStore } from '../store';
import type { Article, MobilePage } from '../types';
import { viewTitle } from '../viewTitle';

interface ListPageProps {
  onNavigate: (page: MobilePage) => void;
}

export default function ListPage({ onNavigate }: ListPageProps) {
  const {
    articles,
    selectedView,
    selectedArticle,
    loadingArticles,
    selectArticle,
    loadArticles,
    listMode,
    setListMode,
  } = useStore();
  const { currentEpisode, isPlaying, isBuffering, onPlay } = useAudio();

  const handleSelectArticle = (article: Article) => {
    selectArticle(article);
    onNavigate('article');
  };

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
    />
  );
}
