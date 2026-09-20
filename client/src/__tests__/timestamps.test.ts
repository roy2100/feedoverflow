import { describe, it, expect } from 'vitest';

import { parseTimestamp, splitTimestamps } from '../lib/timestamps';

const seconds = (text: string) =>
  splitTimestamps(text)
    .filter((s) => s.seconds !== undefined)
    .map((s) => [s.text, s.seconds] as const);

describe('splitTimestamps', () => {
  it('finds the chapter markers real show notes use', () => {
    expect(seconds('(00:00) What Muse is')).toEqual([['(00:00)', 0]]);
    expect(seconds('(04:41) Signing in and the onboarding flow')).toEqual([['(04:41)', 281]]);
    expect(seconds('(1:52) Impact of the data center')).toEqual([['(1:52)', 112]]);
    expect(seconds('(33:34) TL;DR')).toEqual([['(33:34)', 2014]]);
    expect(seconds('1:02:30 the long one')).toEqual([['1:02:30', 3750]]);
  });

  it('absorbs a matching bracket pair, and only a matching one', () => {
    expect(seconds('[1:52] bracketed')).toEqual([['[1:52]', 112]]);
    expect(seconds('bare 1:52 here')).toEqual([['1:52', 112]]);
    expect(seconds('(1:52] mismatched')).toEqual([['1:52', 112]]);
    expect(seconds('(1:52 unclosed')).toEqual([['1:52', 112]]);
  });

  it('round-trips the input text', () => {
    const text = 'a (04:41) b (1:52) c';
    expect(
      splitTimestamps(text)
        .map((s) => s.text)
        .join(''),
    ).toBe(text);
    expect(splitTimestamps(text)).toEqual([
      { text: 'a ' },
      { text: '(04:41)', seconds: 281 },
      { text: ' b ' },
      { text: '(1:52)', seconds: 112 },
      { text: ' c' },
    ]);
  });

  it('ignores digit runs that only look like clocks', () => {
    expect(seconds('http://127.0.0.1:8080/x')).toEqual([]);
    expect(seconds('ratio 12:345')).toEqual([]);
    expect(seconds('year 2024:12')).toEqual([]);
    expect(seconds('12:99 is not a time')).toEqual([]);
    expect(seconds('1:60:00')).toEqual([]);
    expect(seconds('no numbers here')).toEqual([]);
    expect(splitTimestamps('')).toEqual([]);
  });

  it('treats a colon-joined prefix as glue, not a boundary', () => {
    // `10:10:10:10` — the trailing guard stops the first candidate, the leading
    // guard stops every later one, so nothing is a chapter.
    expect(seconds('10:10:10:10')).toEqual([]);
  });
});

describe('parseTimestamp', () => {
  it('accepts both shapes and rejects out-of-range fields', () => {
    expect(parseTimestamp('4:41')).toBe(281);
    expect(parseTimestamp(' 01:02:03 ')).toBe(3723);
    expect(parseTimestamp('4:61')).toBeNull();
    expect(parseTimestamp('abc')).toBeNull();
  });
});
