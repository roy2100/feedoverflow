import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import App from '../App';
import { useStore } from '../store';
import type { Article } from '../types';

// Resume-where-you-left-off lives in <App />, the audio owner: the save is driven
// by the element's own events and the restore hangs off `loadedmetadata` after a
// src swap. Both are invisible to a component test, so this file drives the whole
// app — list → play → close → play again.

const EPISODE: Article = {
  id: 'ep-1',
  feedId: 'f1',
  feedName: '播客源',
  title: '一期节目',
  summary: '',
  content: '',
  link: 'https://example.com/ep',
  pubDate: '2026-07-25T00:00:00Z',
  author: '',
  audioUrl: 'https://example.com/ep.mp3',
  audioDuration: '30:00',
  isStarred: false,
};

const KEY = 'podcast-progress';

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth-check')) return Promise.resolve(jsonRes({ authed: true }));
      if (url.includes('/api/starred/count')) return Promise.resolve(jsonRes({ count: 0 }));
      if (url.includes('/articles') && url.includes('/api/feeds/'))
        return Promise.resolve(jsonRes({ articles: [] }));
      if (url.includes('/api/feeds'))
        return Promise.resolve(
          jsonRes([{ id: 'f1', name: '播客源', url: 'https://p.example/rss' }]),
        );
      if (url.includes('/api/today')) return Promise.resolve(jsonRes({ articles: [EPISODE] }));
      return Promise.resolve(jsonRes({}));
    }),
  );
}

// jsdom has no media playback: play() rejects with "not implemented" and no
// source ever loads, so drive the element's events by hand.
let audioEl: HTMLAudioElement;

function installAudio() {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  vi.stubGlobal('Audio', function () {
    audioEl = document.createElement('audio');
    return audioEl;
  });
}

// What a real source does once it has read the file header.
function metadataLoaded(duration: number) {
  Object.defineProperty(audioEl, 'duration', { value: duration, configurable: true });
  act(() => {
    audioEl.dispatchEvent(new Event('loadedmetadata'));
  });
}

function stored(id: string): number | undefined {
  return JSON.parse(localStorage.getItem(KEY) ?? '{}')[id]?.t;
}

async function playFromList() {
  fireEvent.click(await screen.findByText('30:00'));
}

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    feeds: [],
    articles: [],
    selectedView: { type: 'today' },
    selectedArticle: null,
    loadingArticles: false,
    starredCount: 0,
    lastListView: { type: 'today' },
  });
  installFetch();
  installAudio();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('podcast resume', () => {
  it('picks up where the episode was left, once metadata allows the seek', async () => {
    localStorage.setItem(KEY, JSON.stringify({ 'ep-1': { t: 630, d: 1800, at: Date.now() } }));

    render(<App />);
    await playFromList();

    expect(audioEl.src).toBe(EPISODE.audioUrl);
    // Seeking before the source knows its length is a no-op at best.
    expect(audioEl.currentTime).toBe(0);

    metadataLoaded(1800);
    expect(audioEl.currentTime).toBe(630);
  });

  it('starts at the top when nothing was remembered', async () => {
    render(<App />);
    await playFromList();

    metadataLoaded(1800);
    expect(audioEl.currentTime).toBe(0);
  });

  it('saves the position when the player is closed', async () => {
    render(<App />);
    await playFromList();
    metadataLoaded(1800);

    act(() => {
      audioEl.currentTime = 742;
    });
    // The close button tears down the src, so the save has to beat it.
    fireEvent.click(await screen.findByTitle('关闭播放器'));

    expect(stored('ep-1')).toBe(742);
  });

  it('saves the outgoing episode before switching sources', async () => {
    render(<App />);
    await playFromList();
    metadataLoaded(1800);
    act(() => {
      audioEl.currentTime = 500;
    });

    // Same element, new source: currentTime resets, so the old position is gone
    // unless it was written first.
    const other = { ...EPISODE, id: 'ep-2', audioUrl: 'https://example.com/ep2.mp3' };
    act(() => {
      useStore.getState().selectArticle(other);
    });
    fireEvent.click(await screen.findByText('播放'));

    expect(audioEl.src).toBe(other.audioUrl);
    expect(stored('ep-1')).toBe(500);
  });

  it('saves while playing, so a backgrounded app that gets killed still resumes', async () => {
    render(<App />);
    await playFromList();
    metadataLoaded(1800);

    act(() => {
      audioEl.currentTime = 61;
      audioEl.dispatchEvent(new Event('timeupdate'));
    });

    expect(stored('ep-1')).toBe(61);
  });

  it('forgets the position once the episode finishes', async () => {
    render(<App />);
    await playFromList();
    metadataLoaded(1800);
    act(() => {
      audioEl.currentTime = 1798;
      audioEl.dispatchEvent(new Event('timeupdate'));
    });
    expect(stored('ep-1')).toBe(1798);

    act(() => {
      audioEl.dispatchEvent(new Event('ended'));
    });

    expect(stored('ep-1')).toBeUndefined();
  });
});
