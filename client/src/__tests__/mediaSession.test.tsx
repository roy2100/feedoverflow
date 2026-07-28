import { act, render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

import PodcastPlayer from '../components/PodcastPlayer';
import type { Article } from '../types';

const noop = () => {};

const EPISODE: Article = {
  id: 'ep-1',
  feedId: 'feed-1',
  feedName: '声动早咖啡',
  title: 'Episode &amp; Friends',
  summary: '',
  content: '',
  link: 'https://example.com/ep',
  pubDate: '2025-01-01T00:00:00Z',
  author: '',
  isStarred: false,
  audioUrl: 'https://example.com/ep.mp3',
  audioDuration: '26:12',
};

interface MediaSessionStub {
  metadata: MediaMetadata | null;
  playbackState: MediaSessionPlaybackState;
  handlers: Map<string, MediaSessionActionHandler | null>;
  setActionHandler: (a: string, h: MediaSessionActionHandler | null) => void;
  setPositionState: ReturnType<typeof vi.fn>;
}

let ms: MediaSessionStub;

// jsdom implements neither, so stand both up before the component mounts.
function installMediaSession() {
  ms = {
    metadata: null,
    playbackState: 'none',
    handlers: new Map(),
    setActionHandler: (a, h) => ms.handlers.set(a, h),
    setPositionState: vi.fn(),
  };
  vi.stubGlobal(
    'MediaMetadata',
    class {
      title: string;
      artist: string;
      artwork: MediaImage[];
      constructor(init: MediaMetadataInit = {}) {
        this.title = init.title ?? '';
        this.artist = init.artist ?? '';
        this.artwork = init.artwork ?? [];
      }
    },
  );
  Object.defineProperty(navigator, 'mediaSession', { value: ms, configurable: true });
}

// Invoke a lock-screen action the way the OS would.
function fire(action: string, details: object = {}) {
  act(() => {
    ms.handlers.get(action)?.({ action, ...details } as MediaSessionActionDetails);
  });
}

function renderPlayer(isPlaying = true) {
  const audio = document.createElement('audio');
  audio.currentTime = 30;
  audio.play = vi.fn().mockResolvedValue(undefined);
  audio.pause = vi.fn();
  const audioRef = { current: audio } as React.RefObject<HTMLAudioElement>;
  const onClose = vi.fn();
  const view = render(
    <PodcastPlayer
      episode={EPISODE}
      audioRef={audioRef}
      isPlaying={isPlaying}
      isBuffering={false}
      onTogglePlay={noop}
      onClose={onClose}
    />,
  );
  return { audio, onClose, view };
}

describe('podcast lock-screen controls', () => {
  beforeEach(installMediaSession);
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'mediaSession');
  });

  it('publishes the episode, not the app name, as the now-playing title', () => {
    renderPlayer();
    expect(ms.metadata?.title).toBe('Episode & Friends');
    expect(ms.metadata?.artist).toBe('声动早咖啡');
    expect(ms.metadata?.artwork.length).toBeGreaterThan(0);
    expect(ms.playbackState).toBe('playing');
  });

  it('reports the feed duration when the element has none, and skips 15s', () => {
    const { audio } = renderPlayer();
    // The element reported no metadata, so duration comes from "26:12".
    expect(ms.setPositionState).toHaveBeenCalledWith(
      expect.objectContaining({ duration: 26 * 60 + 12, playbackRate: 1 }),
    );

    fire('seekforward');
    expect(audio.currentTime).toBe(45);
    fire('seekbackward');
    expect(audio.currentTime).toBe(30);
  });

  it('honours the offset the OS asks for, and absolute seeks', () => {
    const { audio } = renderPlayer();
    fire('seekforward', { seekOffset: 10 });
    expect(audio.currentTime).toBe(40);
    fire('seekto', { seekTime: 120 });
    expect(audio.currentTime).toBe(120);
  });

  it('maps play/pause/stop to their own actions', () => {
    const { audio, onClose } = renderPlayer();
    fire('play');
    expect(audio.play).toHaveBeenCalled();
    fire('pause');
    expect(audio.pause).toHaveBeenCalled();
    fire('stop');
    expect(onClose).toHaveBeenCalled();
  });

  it('clears the now-playing card when the player closes', () => {
    const { view } = renderPlayer();
    expect(screen.getByText('Episode & Friends')).toBeInTheDocument();
    view.unmount();
    expect(ms.metadata).toBeNull();
    expect(ms.playbackState).toBe('none');
  });
});
