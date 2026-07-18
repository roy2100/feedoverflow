import { useAudio } from '../AudioContext';
import ArticleReader from '../components/ArticleReader';
import { useStore } from '../store';
import type { MobilePage } from '../types';

interface ReaderPageProps {
  onNavigate: (page: MobilePage) => void;
}

export default function ReaderPage({ onNavigate }: ReaderPageProps) {
  const { selectedArticle, toggleStar } = useStore();
  const { currentEpisode, isPlaying, isBuffering, onPlay } = useAudio();

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
      isBuffering={isBuffering}
    />
  );
}
