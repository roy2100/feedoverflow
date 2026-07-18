import { useAudio } from '../AudioContext';
import ArticleList from '../components/ArticleList';
import { useStore } from '../store';
import type { Article, MobilePage } from '../types';

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
      viewTitle={viewTitle}
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
