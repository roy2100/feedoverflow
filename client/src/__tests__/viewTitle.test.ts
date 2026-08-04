import { describe, it, expect } from 'vitest';

import type { Collection, Feed, View } from '../types';
import { viewTitle } from '../viewTitle';

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
  ])('%o renders as %s', (view, expected) => {
    expect(viewTitle(view)).toBe(expected);
  });

  // Every branch must return a string: an undefined title renders an empty header,
  // which is the bug this function exists to prevent — not a crash, just a blank
  // bar with no way to tell what you are looking at.
  it.each<View>([{ type: 'feed' }, { type: 'collection' }, { type: 'search' }])(
    '%o degrades to an empty string, never undefined',
    (view) => {
      expect(typeof viewTitle(view)).toBe('string');
    },
  );
});
