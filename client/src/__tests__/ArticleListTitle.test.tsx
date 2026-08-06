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
  it('shows only the original when there is no translation', () => {
    renderList(article());
    expect(screen.getByText('Apple unveils M5 chip')).toBeTruthy();
  });

  // The chosen display is 译文主、原文次: a machine-translated headline can be
  // wrong, so the original has to stay on screen as the check — demoted, never
  // replaced.
  it('shows both the translation and the original when translated', () => {
    renderList(article({ titleZh: '苹果发布 M5 芯片' }));
    expect(screen.getByText('苹果发布 M5 芯片')).toBeTruthy();
    expect(screen.getByText('Apple unveils M5 chip')).toBeTruthy();
  });

  // Both row layouts render the title, so both need the second line.
  it('shows both in the hideFeedName layout too', () => {
    renderList(article({ titleZh: '苹果发布 M5 芯片' }), true);
    expect(screen.getByText('苹果发布 M5 芯片')).toBeTruthy();
    expect(screen.getByText('Apple unveils M5 chip')).toBeTruthy();
  });

  // An all-whitespace value is not a translation; it must not push an empty line
  // in and demote the real headline to grey small text.
  it('ignores a blank translation', () => {
    renderList(article({ titleZh: '   ' }));
    const original = screen.getByText('Apple unveils M5 chip');
    expect(original).toBeTruthy();
    expect(screen.queryByText('   ')).toBeNull();
  });
});
