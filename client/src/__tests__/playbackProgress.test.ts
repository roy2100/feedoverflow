import { describe, it, expect, beforeEach } from 'vitest';

import { saveProgress, loadProgress, clearProgress } from '../lib/playbackProgress';

const KEY = 'podcast-progress';

describe('playbackProgress', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a mid-episode position', () => {
    saveProgress('ep-1', 630, 1800);
    expect(loadProgress('ep-1')).toBe(630);
    expect(loadProgress('ep-unknown')).toBe(0);
  });

  it('starts over rather than resuming the first few seconds', () => {
    saveProgress('ep-1', 4, 1800);
    expect(loadProgress('ep-1')).toBe(0);
  });

  it('starts over once the episode ran to the end', () => {
    saveProgress('ep-1', 1795, 1800);
    expect(loadProgress('ep-1')).toBe(0);
    // …but an unknown duration can never look "finished".
    saveProgress('ep-2', 1795, NaN);
    expect(loadProgress('ep-2')).toBe(1795);
  });

  it('ignores a position of zero, so a reset src cannot erase a real one', () => {
    saveProgress('ep-1', 630, 1800);
    saveProgress('ep-1', 0, 1800);
    expect(loadProgress('ep-1')).toBe(630);
  });

  it('clears one episode without touching the others', () => {
    saveProgress('ep-1', 630, 1800);
    saveProgress('ep-2', 200, 1800);
    clearProgress('ep-1');
    expect(loadProgress('ep-1')).toBe(0);
    expect(loadProgress('ep-2')).toBe(200);
  });

  it('prunes to the 200 most recently touched episodes', () => {
    const old = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [`old-${i}`, { t: 100, d: 1800, at: i }]),
    );
    localStorage.setItem(KEY, JSON.stringify(old));

    saveProgress('fresh', 300, 1800);

    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    expect(Object.keys(stored)).toHaveLength(200);
    expect(loadProgress('fresh')).toBe(300);
    expect(loadProgress('old-249')).toBe(100); // newest survivor
    expect(loadProgress('old-0')).toBe(0); // oldest pruned
  });

  it('survives corrupt storage', () => {
    localStorage.setItem(KEY, 'not json');
    expect(loadProgress('ep-1')).toBe(0);
    saveProgress('ep-1', 630, 1800);
    expect(loadProgress('ep-1')).toBe(630);
  });
});
