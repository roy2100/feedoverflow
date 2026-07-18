import { Play, Pause, X, Loader2 } from 'lucide-react';
import { useState, useEffect } from 'react';

import { useIsMobile } from '../hooks/useIsMobile';
import { decodeEntities } from '../lib/decodeEntities';
import type { Article } from '../types';

interface PodcastPlayerProps {
  episode: Article;
  audioRef: React.RefObject<HTMLAudioElement>;
  isPlaying: boolean;
  isBuffering: boolean;
  onTogglePlay: () => void;
  onClose: () => void;
}

export default function PodcastPlayer({
  episode,
  audioRef,
  isPlaying,
  isBuffering,
  onTogglePlay,
  onClose,
}: PodcastPlayerProps) {
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const isMobile = useIsMobile();

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onMeta = () => setDuration(isFinite(audio.duration) ? audio.duration : 0);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onMeta);
    };
  }, []); // eslint-disable-line -- audioRef is a stable ref

  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setSpeed(1);
    if (audioRef.current) audioRef.current.playbackRate = 1;
  }, [episode?.id]); // eslint-disable-line

  const skip = (sec: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(a.currentTime + sec, a.duration || 0));
  };

  const cycleSpeed = () => {
    const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const fmt = (s: number) => {
    if (!s || isNaN(s) || !isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };

  // Parse the feed-provided clock duration ("33:56" / "1:29:55") to seconds.
  const parseClock = (s: string | undefined): number => {
    if (!s) return 0;
    const parts = s.split(':').map(Number);
    if (parts.some((n) => isNaN(n))) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  };

  // Streaming sources often expose no `duration` on the audio element (stays 0
  // or Infinity), which would strand the seek bar at full and show 0:00. Fall
  // back to the feed's own duration so the player matches the reader.
  const effectiveDuration = duration || parseClock(episode.audioDuration);

  const btnStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
    flexShrink: 0,
    transition: 'background 0.12s',
  };

  if (isMobile) {
    return (
      <div
        style={{
          flexShrink: 0,
          background: 'var(--bg-panel)',
          borderTop: '1px solid var(--border)',
          padding: '8px 12px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {/* Row 1: play + title + speed + close */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={onTogglePlay}
            style={{ ...btnStyle, padding: 4, color: 'var(--accent)' }}
          >
            {isBuffering ? (
              <Loader2
                size={18}
                strokeWidth={2}
                style={{ animation: 'spin 0.8s linear infinite' }}
              />
            ) : isPlaying ? (
              <Pause size={18} strokeWidth={2} />
            ) : (
              <Play size={18} strokeWidth={2} />
            )}
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                lineHeight: 1.4,
              }}
            >
              {decodeEntities(episode.title)}
            </div>
            {episode.feedName && (
              <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>
                {episode.feedName}
              </div>
            )}
          </div>
          <button
            onClick={cycleSpeed}
            style={{
              ...btnStyle,
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--accent-light)',
              padding: '2px 6px',
              minWidth: 28,
            }}
          >
            {speed}×
          </button>
          <button
            onClick={onClose}
            style={{ ...btnStyle, padding: 4, color: 'var(--text-tertiary)' }}
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>

        {/* Row 2: skip + seek + time + skip */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => skip(-15)}
            style={{
              ...btnStyle,
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-secondary)',
              padding: '2px 5px',
            }}
          >
            -15
          </button>
          <input
            type="range"
            min={0}
            max={effectiveDuration || 100}
            value={currentTime}
            step={1}
            onChange={(e) => {
              const t = parseFloat(e.target.value);
              if (audioRef.current) audioRef.current.currentTime = t;
              setCurrentTime(t);
            }}
            style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer', height: 4 }}
          />
          <button
            onClick={() => skip(15)}
            style={{
              ...btnStyle,
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-secondary)',
              padding: '2px 5px',
            }}
          >
            +15
          </button>
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              flexShrink: 0,
              minWidth: 38,
              textAlign: 'right',
            }}
          >
            {fmt(currentTime)}
          </span>
        </div>
      </div>
    );
  }

  // Desktop layout (unchanged)
  return (
    <div
      style={{
        height: 56,
        flexShrink: 0,
        background: 'var(--bg-panel)',
        borderTop: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        gap: 10,
      }}
    >
      <button
        onClick={onTogglePlay}
        style={{ ...btnStyle, padding: 6, color: 'var(--accent)' }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
      >
        {isBuffering ? (
          <Loader2 size={17} strokeWidth={2} style={{ animation: 'spin 0.8s linear infinite' }} />
        ) : isPlaying ? (
          <Pause size={17} strokeWidth={2} />
        ) : (
          <Play size={17} strokeWidth={2} />
        )}
      </button>

      <div style={{ minWidth: 0, width: 180, flexShrink: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            lineHeight: 1.4,
          }}
        >
          {decodeEntities(episode.title)}
        </div>
        {episode.feedName && (
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--text-tertiary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              lineHeight: 1.4,
            }}
          >
            {episode.feedName}
          </div>
        )}
      </div>

      <button
        onClick={() => skip(-15)}
        title="-15秒"
        style={{
          ...btnStyle,
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-secondary)',
          padding: '3px 6px',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
      >
        -15
      </button>

      <span
        style={{
          fontSize: 11,
          color: 'var(--text-tertiary)',
          flexShrink: 0,
          minWidth: 32,
          textAlign: 'right',
        }}
      >
        {fmt(currentTime)}
      </span>

      <input
        type="range"
        min={0}
        max={duration || 100}
        value={currentTime}
        step={1}
        onChange={(e) => {
          const t = parseFloat(e.target.value);
          if (audioRef.current) audioRef.current.currentTime = t;
          setCurrentTime(t);
        }}
        style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer', height: 4 }}
      />

      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0, minWidth: 32 }}>
        {fmt(effectiveDuration)}
      </span>

      <button
        onClick={() => skip(15)}
        title="+15秒"
        style={{
          ...btnStyle,
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-secondary)',
          padding: '3px 6px',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
      >
        +15
      </button>

      <button
        onClick={cycleSpeed}
        title="切换播放速度"
        style={{
          ...btnStyle,
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--accent-light)',
          padding: '3px 7px',
          minWidth: 30,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
      >
        {speed}×
      </button>

      <button
        onClick={onClose}
        title="关闭播放器"
        style={{ ...btnStyle, padding: 5, color: 'var(--text-tertiary)' }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--bg-hover)';
          e.currentTarget.style.color = 'var(--text-primary)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'none';
          e.currentTarget.style.color = 'var(--text-tertiary)';
        }}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
