import { useStore } from '../store';
import { useAudio } from '../AudioContext';
import ArticleReader from '../components/ArticleReader';

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
