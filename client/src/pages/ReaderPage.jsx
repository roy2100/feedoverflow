import { useAudio } from '../AudioContext';
import ArticleReader from '../components/ArticleReader';
import { useStore } from '../store';

export default function ReaderPage({ onNavigate }) {
  const { selectedArticle, toggleStar } = useStore();
  const { currentEpisode, isPlaying, onPlay } = useAudio();

  if (!selectedArticle) return null;

  return (
    <ArticleReader
      isMobile
      onBack={() => onNavigate('list')}
      article={selectedArticle}
      onToggleStar={toggleStar}
      onPlay={onPlay}
      currentEpisode={currentEpisode}
      isPlaying={isPlaying}
    />
  );
}
