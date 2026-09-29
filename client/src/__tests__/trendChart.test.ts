import { describe, it, expect } from 'vitest';

import { movingAverage, niceMax } from '../components/TrendChart';

describe('niceMax', () => {
  it.each([
    [0, 1],
    [1, 1],
    [3, 5],
    [7, 10],
    [32, 50],
    [100, 100],
    [101, 200],
  ])('%i rounds up to %i', (n, want) => {
    expect(niceMax(n)).toBe(want);
  });
});

describe('movingAverage', () => {
  it('needs a full week and never averages in today (the last, partial bucket)', () => {
    const counts = [7, 0, 0, 0, 0, 0, 0, 14, 1];
    expect(movingAverage(counts)).toEqual([null, null, null, null, null, null, 1, 2, null]);
  });
});
