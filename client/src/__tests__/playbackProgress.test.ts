import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  saveProgress,
  loadProgress,
  clearProgress,
  hydrate,
  __resetProgressCache,
} from '../lib/playbackProgress';

// Positions live in SQLite now (see docs/plan-podcast-progress-sqlite.md), with an
// in-memory map in front so the resume seek can stay synchronous. So the unit under
// test is that pair: what loadProgress answers, and what actually goes over the wire.

const API = '/api/podcast-progress';

interface Sent {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let sent: Sent[];
let getResponse: Record<string, number>;

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ progress: getResponse }),
        } as unknown as Response);
      }
      sent.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return Promise.resolve({ ok: true, status: 200 } as unknown as Response);
    }),
  );
}

beforeEach(() => {
  sent = [];
  getResponse = {};
  __resetProgressCache();
  installFetch();
  // jsdom has no sendBeacon; be explicit so these cases exercise the fetch path.
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { sendBeacon: undefined }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('playbackProgress', () => {
  it('round-trips a mid-episode position through the in-memory map', () => {
    saveProgress('ep-1', 630, 1800);
    expect(loadProgress('ep-1')).toBe(630);
    expect(loadProgress('ep-unknown')).toBe(0);

    expect(sent).toEqual([
      { url: API, method: 'POST', body: { id: 'ep-1', position: 630, duration: 1800 } },
    ]);
  });

  it('hydrates from the server, so a fresh app resumes what another session left', async () => {
    getResponse = { 'ep-1': 630, 'ep-2': 90 };
    await hydrate();

    expect(loadProgress('ep-1')).toBe(630);
    expect(loadProgress('ep-2')).toBe(90);
    // Hydration is a read — it must not write anything back.
    expect(sent).toEqual([]);
  });

  it('rounds to whole seconds — sub-second precision is invisible in a resume', () => {
    saveProgress('ep-1', 630.42, 1800);
    expect(loadProgress('ep-1')).toBe(630);
    expect(sent[0].body).toMatchObject({ position: 630 });
  });

  it('starts over rather than resuming the first few seconds', () => {
    saveProgress('ep-1', 4, 1800);
    expect(loadProgress('ep-1')).toBe(0);
    // Still recorded, though: a refused seek that restarted playback has to be able
    // to overwrite a stale resume point.
    expect(sent[0].body).toMatchObject({ id: 'ep-1', position: 4 });
  });

  it('forgets the position once the episode ran to the end', () => {
    saveProgress('ep-1', 600, 1800);
    sent = [];

    saveProgress('ep-1', 1795, 1800);

    expect(loadProgress('ep-1')).toBe(0);
    expect(sent).toEqual([{ url: `${API}/ep-1`, method: 'DELETE', body: null }]);
  });

  it('never treats an unknown duration as finished', () => {
    saveProgress('ep-2', 1795, NaN);
    expect(loadProgress('ep-2')).toBe(1795);
    expect(sent[0].body).toMatchObject({ id: 'ep-2', position: 1795, duration: 0 });
  });

  it('ignores a position of zero, so a reset src cannot erase a real one', () => {
    saveProgress('ep-1', 630, 1800);
    sent = [];

    saveProgress('ep-1', 0, 1800);

    expect(loadProgress('ep-1')).toBe(630);
    expect(sent).toEqual([]);
  });

  it('does not re-send the same delete through the closing credits', () => {
    saveProgress('ep-1', 600, 1800);
    sent = [];

    saveProgress('ep-1', 1790, 1800);
    saveProgress('ep-1', 1795, 1800);
    saveProgress('ep-1', 1799, 1800);

    expect(sent).toHaveLength(1);
  });

  it('clears one episode without touching the others', () => {
    saveProgress('ep-1', 630, 1800);
    saveProgress('ep-2', 200, 1800);
    clearProgress('ep-1');

    expect(loadProgress('ep-1')).toBe(0);
    expect(loadProgress('ep-2')).toBe(200);
    expect(sent.at(-1)).toEqual({ url: `${API}/ep-1`, method: 'DELETE', body: null });
  });

  it('clears unconditionally — an unhydrated id is no evidence the server has nothing', () => {
    clearProgress('ep-never-seen');
    expect(sent).toEqual([{ url: `${API}/ep-never-seen`, method: 'DELETE', body: null }]);
  });

  it('resumes even when the write never reaches the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );

    saveProgress('ep-1', 630, 1800);
    // The map is the read path, so an offline save still resumes in this session.
    expect(loadProgress('ep-1')).toBe(630);
    // And a failed hydrate is the same as never having listened.
    __resetProgressCache();
    await hydrate();
    expect(loadProgress('ep-1')).toBe(0);
  });
});

describe('playbackProgress transport', () => {
  beforeEach(() => {
    sent = [];
    __resetProgressCache();
    installFetch();
  });

  // The save that matters most fires from `visibilitychange: hidden` on an iOS PWA
  // that is about to be killed, where a plain fetch can be dropped.
  it('prefers sendBeacon for saves', () => {
    const beacon = vi.fn((_url: string, _body?: BodyInit | null) => true);
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { sendBeacon: beacon }));

    saveProgress('ep-1', 630, 1800);

    expect(beacon).toHaveBeenCalledOnce();
    expect(beacon.mock.calls[0][0]).toBe(API);
    expect(sent).toEqual([]);
  });

  it('falls back to fetch when the beacon is refused', () => {
    vi.stubGlobal(
      'navigator',
      Object.assign(Object.create(navigator), { sendBeacon: vi.fn(() => false) }),
    );

    saveProgress('ep-1', 630, 1800);

    expect(sent).toEqual([
      { url: API, method: 'POST', body: { id: 'ep-1', position: 630, duration: 1800 } },
    ]);
  });
});
