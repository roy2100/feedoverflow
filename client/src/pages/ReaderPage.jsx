import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { useAudio } from '../AudioContext';
import ArticleReader from '../components/ArticleReader';

export default function ReaderPage() {
  const navigate = useNavigate();
  const { selectedArticle, toggleStar } = useStore();
  const { currentEpisode, isPlaying, onPlay } = useAudio();

  useEffect(() => {
    if (!selectedArticle) navigate('/list', { replace: true });
  }, [selectedArticle, navigate]);

  if (!selectedArticle) return null;

  return (
    <ArticleReader
      isMobile
      onBack={() => navigate('/list')}
      article={selectedArticle}
      onToggleStar={toggleStar}
      onPlay={onPlay}
      currentEpisode={currentEpisode}
      isPlaying={isPlaying}
    />
  );
}
