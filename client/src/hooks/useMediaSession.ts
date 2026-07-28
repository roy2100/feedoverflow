import { useEffect, useRef } from 'react';

// Artwork for the OS media controls. Without an explicit list the lock screen
// falls back to the PWA icon on iOS and to nothing at all on some Android
// browsers, so pin the app icons ourselves. Feeds carry no cover art in the DB,
// so this is the app icon, not the podcast's.
const ARTWORK: MediaImage[] = [
  { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
  { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
];

// The app's own -15/+15 buttons. Used when the OS asks for a skip without
// naming an interval; when it does name one (`seekOffset`), honour it so the
// jump matches the number drawn on the button.
const SKIP_SECONDS = 15;

interface Options {
  title: string;
  artist: string;
  isPlaying: boolean;
  /** Current playhead, seconds. */
  position: number;
  /** Total length, seconds — 0 when still unknown. */
  duration: number;
  playbackRate: number;
  onPlay: () => void;
  onPause: () => void;
  /** Absolute seek, seconds. */
  onSeek: (seconds: number) => void;
  /** Relative seek, signed seconds. */
  onSkip: (seconds: number) => void;
  onStop: () => void;
}

// Mirrors the playing episode into the OS media controls (iOS lock screen /
// Control Center, Android notification, macOS Now Playing). Without it the
// lock screen shows the PWA name as the title and the UA's own default skip
// buttons, which is what a bare <audio> element gets you.
export function useMediaSession({
  title,
  artist,
  isPlaying,
  position,
  duration,
  playbackRate,
  onPlay,
  onPause,
  onSeek,
  onSkip,
  onStop,
}: Options) {
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;

  // Handlers are registered once and read the latest callbacks through this
  // ref: re-registering them on every render would mean four times a second
  // while playing, since `position` ticks with timeupdate.
  const cbs = useRef({ onPlay, onPause, onSeek, onSkip, onStop });
  cbs.current = { onPlay, onPause, onSeek, onSkip, onStop };

  useEffect(() => {
    if (!ms || typeof MediaMetadata === 'undefined') return;
    ms.metadata = new MediaMetadata({ title, artist, artwork: ARTWORK });
  }, [ms, title, artist]);

  useEffect(() => {
    if (!ms) return;
    ms.playbackState = isPlaying ? 'playing' : 'paused';
  }, [ms, isPlaying]);

  // Feeds the scrubber. Skipped while the duration is unknown (streaming
  // sources report 0/Infinity) — setPositionState throws on a non-finite
  // duration or a position past its end.
  useEffect(() => {
    if (!ms?.setPositionState) return;
    if (!Number.isFinite(duration) || duration <= 0) return;
    ms.setPositionState({
      duration,
      position: Math.min(Math.max(position, 0), duration),
      playbackRate: playbackRate > 0 ? playbackRate : 1,
    });
  }, [ms, position, duration, playbackRate]);

  useEffect(() => {
    if (!ms) return;
    const skip = (sign: number) => (details: MediaSessionActionDetails) =>
      cbs.current.onSkip(sign * (details.seekOffset || SKIP_SECONDS));

    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => cbs.current.onPlay()],
      ['pause', () => cbs.current.onPause()],
      ['stop', () => cbs.current.onStop()],
      ['seekbackward', skip(-1)],
      ['seekforward', skip(1)],
      [
        'seekto',
        (details) => {
          if (typeof details.seekTime === 'number') cbs.current.onSeek(details.seekTime);
        },
      ],
    ];
    for (const [action, handler] of handlers) {
      // Actions a UA doesn't implement throw on assignment rather than no-op.
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* unsupported action */
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          /* unsupported action */
        }
      }
    };
  }, [ms]);

  // Unmounting means the player was closed: drop the now-playing card rather
  // than leaving a stale one on the lock screen.
  useEffect(() => {
    if (!ms) return;
    return () => {
      ms.metadata = null;
      ms.playbackState = 'none';
    };
  }, [ms]);
}
