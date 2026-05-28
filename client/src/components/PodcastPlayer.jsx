import { useState, useEffect } from 'react';
import { Play, Pause, X } from 'lucide-react';

export default function PodcastPlayer({ episode, audioRef, isPlaying, onTogglePlay, onClose }) {
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    const audio = audioRef.current;
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
  }, []); // audioRef is stable

  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setSpeed(1);
    if (audioRef.current) audioRef.current.playbackRate = 1;
  }, [episode?.id]); // eslint-disable-line

  const skip = (sec) => {
    const a = audioRef.current;
    a.currentTime = Math.max(0, Math.min(a.currentTime + sec, a.duration || 0));
  };

  const cycleSpeed = () => {
    const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
    setSpeed(next);
    audioRef.current.playbackRate = next;
  };

  const fmt = (s) => {
    if (!s || isNaN(s) || !isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };

  const btnStyle = {
    background: 'none', border: 'none', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 5, flexShrink: 0, transition: 'background 0.12s',
  };

  return (
    <div style={{
      height: 56, flexShrink: 0,
      background: 'var(--bg-panel)',
      borderTop: '1px solid var(--border)',
      display: 'flex', alignItems: 'center',
      padding: '0 16px', gap: 10,
    }}>
      {/* Play/Pause */}
      <button
        onClick={onTogglePlay}
        style={{ ...btnStyle, padding: 6, color: 'var(--accent)' }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'none'}
      >
        {isPlaying ? <Pause size={17} strokeWidth={2} /> : <Play size={17} strokeWidth={2} />}
      </button>

      {/* Episode info */}
      <div style={{ minWidth: 0, width: 180, flexShrink: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.4 }}>
          {episode.title}
        </div>
        {episode.feedName && (
          <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.4 }}>
            {episode.feedName}
          </div>
        )}
      </div>

      {/* Skip back */}
      <button
        onClick={() => skip(-15)}
        title="-15秒"
        style={{ ...btnStyle, fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', padding: '3px 6px' }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'none'}
      >
        -15
      </button>

      {/* Current time */}
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0, minWidth: 32, textAlign: 'right' }}>
        {fmt(currentTime)}
      </span>

      {/* Seek bar */}
      <input
        type="range"
        min={0}
        max={duration || 100}
        value={currentTime}
        step={1}
        onChange={e => {
          const t = parseFloat(e.target.value);
          audioRef.current.currentTime = t;
          setCurrentTime(t);
        }}
        style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer', height: 4 }}
      />

      {/* Duration */}
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0, minWidth: 32 }}>
        {fmt(duration)}
      </span>

      {/* Skip forward */}
      <button
        onClick={() => skip(15)}
        title="+15秒"
        style={{ ...btnStyle, fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', padding: '3px 6px' }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'none'}
      >
        +15
      </button>

      {/* Speed */}
      <button
        onClick={cycleSpeed}
        title="切换播放速度"
        style={{ ...btnStyle, fontSize: 11, fontWeight: 600, color: 'var(--accent-light)', padding: '3px 7px', minWidth: 30 }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'none'}
      >
        {speed}×
      </button>

      {/* Close */}
      <button
        onClick={onClose}
        title="关闭播放器"
        style={{ ...btnStyle, padding: 5, color: 'var(--text-tertiary)' }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-tertiary)'; }}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
