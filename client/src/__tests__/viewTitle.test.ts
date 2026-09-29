import { describe, it, expect } from 'vitest';

import type { Collection, Feed, View } from '../types';
import { emptyTextOf, searchTabOf, viewTitle } from '../viewTitle';

// Desktop and mobile both render the list header from this one function. It used
// to be duplicated in App.tsx and ListPage.tsx, and the copies drifted: collections
// were added to one and the mobile header went blank.
describe('viewTitle', () => {
  const feed = { id: 'f1', name: '少数派' } as Feed;
  const collection = { id: 'c1', name: '每日', rules: [] } as Collection;

  it.each<[View, string]>([
    [{ type: 'all' }, '全部'],
    [{ type: 'today' }, '今日'],
    [{ type: 'starred' }, '收藏'],
    [{ type: 'podcast' }, '播客'],
    [{ type: 'feed', feed }, '少数派'],
    [{ type: 'collection', collection }, '每日'],
    [{ type: 'search', query: 'rust' }, '搜索：rust'],
    [{ type: 'trend', query: 'rust', days: 30 }, '搜索：rust'],
  ])('%o renders as %s', (view, expected) => {
    expect(viewTitle(view)).toBe(expected);
  });

  // Every branch must return a string: an undefined title renders an empty header,
  // which is the bug this function exists to prevent — not a crash, just a blank
  // bar with no way to tell what you are looking at.
  it.each<View>([{ type: 'feed' }, { type: 'collection' }, { type: 'search' }, { type: 'trend' }])(
    '%o degrades to an empty string, never undefined',
    (view) => {
      expect(typeof viewTitle(view)).toBe('string');
    },
  );
});

describe('searchTabOf / emptyTextOf', () => {
  it('shows the 结果 | 趋势 toggle only while searching', () => {
    expect(searchTabOf({ type: 'search', query: 'x' })).toBe('results');
    expect(searchTabOf({ type: 'trend', query: 'x' })).toBe('trend');
    expect(searchTabOf({ type: 'all' })).toBeUndefined();
  });

  it('says the window was searched when a trend finds nothing', () => {
    expect(emptyTextOf({ type: 'trend', query: 'Muse', days: 7 })).toBe(
      '近 7 天没有提到「Muse」的文章',
    );
    expect(emptyTextOf({ type: 'trend', query: 'Muse', day: '2026-09-29' })).toBeUndefined();
    expect(emptyTextOf({ type: 'all' })).toBeUndefined();
  });
});
