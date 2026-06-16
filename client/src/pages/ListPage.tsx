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
    liveRefresh,
    toggleLiveRefresh,
  } = useStore();
  const { currentEpisode, isPlaying, onPlay } = useAudio();

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
      hideFeedName={selectedView.type === 'feed'}
      live={selectedView.type === 'today'}
      liveOn={liveRefresh}
      onToggleLive={toggleLiveRefresh}
    />
  );
}
