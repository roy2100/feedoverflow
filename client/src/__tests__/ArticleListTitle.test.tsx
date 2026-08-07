import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import ArticleList from '../components/ArticleList';
import type { Article } from '../types';

function article(overrides: Partial<Article> = {}): Article {
  return {
    id: 'a1',
    feedId: 'f1',
    feedName: 'Ars Technica',
    title: 'Apple unveils M5 chip',
    summary: '',
    content: '',
    link: 'https://example.com/a1',
    pubDate: new Date().toISOString(),
    author: '',
    audioUrl: '',
    audioDuration: '',
    isStarred: false,
    ...overrides,
  };
}

function renderList(a: Article, hideFeedName = false) {
  render(
    <ArticleList
      articles={[a]}
      selectedArticle={null}
      onSelectArticle={vi.fn()}
      loading={false}
      onRefresh={vi.fn()}
      onPlay={vi.fn()}
      currentEpisode={null}
      isPlaying={false}
      isBuffering={false}
      hideFeedName={hideFeedName}
    />,
  );
}

describe('article row title', () => {
  it('shows the original when there is no translation', () => {
    renderList(article());
    expect(screen.getByText('Apple unveils M5 chip')).toBeTruthy();
  });

  // The original used to sit on a muted second line here. It doubled every row's
  // height and was clipped mid-word, and scanning a list is the one place it earns
  // nothing — checking a suspect translation happens on the article you opened,
  // and ArticleReader still shows both.
  it('replaces the original outright when translated', () => {
    renderList(article({ titleZh: '苹果发布 M5 芯片' }));
    expect(screen.getByText('苹果发布 M5 芯片')).toBeTruthy();
    expect(screen.queryByText('Apple unveils M5 chip')).toBeNull();
  });

  it('does the same in the hideFeedName layout', () => {
    renderList(article({ titleZh: '苹果发布 M5 芯片' }), true);
    expect(screen.getByText('苹果发布 M5 芯片')).toBeTruthy();
    expect(screen.queryByText('Apple unveils M5 chip')).toBeNull();
  });

  // An all-whitespace value is not a translation; it must not blank the headline.
  it('ignores a blank translation', () => {
    renderList(article({ titleZh: '   ' }));
    expect(screen.getByText('Apple unveils M5 chip')).toBeTruthy();
  });
});
