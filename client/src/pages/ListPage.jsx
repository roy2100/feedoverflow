import { useStore } from '../store';
import { useAudio } from '../AudioContext';
import ArticleList from '../components/ArticleList';

export default function ListPage({ onNavigate }) {
  const { articles, selectedView, selectedArticle, loadingArticles, selectArticle, loadArticles } = useStore();
  const { currentEpisode, isPlaying, onPlay } = useAudio();

  const viewTitle =
    selectedView.type === 'all'     ? '全部未读' :
    selectedView.type === 'today'   ? '今日' :
    selectedView.type === 'starred' ? '已收藏' :
    selectedView.feed?.name;

  const handleSelectArticle = (article) => {
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
    />
  );
}
