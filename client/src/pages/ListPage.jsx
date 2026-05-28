import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { useAudio } from '../AudioContext';
import ArticleList from '../components/ArticleList';

export default function ListPage() {
  const navigate = useNavigate();
  const { articles, selectedView, selectedArticle, loadingArticles, selectArticle, loadArticles, listScrollTop, setListScrollTop } = useStore();
  const { currentEpisode, isPlaying, onPlay } = useAudio();

  const viewTitle =
    selectedView.type === 'all'     ? '全部未读' :
    selectedView.type === 'today'   ? '今日' :
    selectedView.type === 'starred' ? '已收藏' :
    selectedView.feed?.name;

  const handleSelectArticle = (article) => {
    selectArticle(article);
    navigate(`/article/${article.id}`);
  };

  return (
    <ArticleList
      isMobile
      onBack={() => navigate('/')}
      articles={articles}
      selectedArticle={selectedArticle}
      onSelectArticle={handleSelectArticle}
      loading={loadingArticles}
      viewTitle={viewTitle}
      onRefresh={() => loadArticles(selectedView)}
      onPlay={onPlay}
      currentEpisode={currentEpisode}
      isPlaying={isPlaying}
      scrollTop={listScrollTop}
      onScroll={setListScrollTop}
    />
  );
}
