import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import ArticleDeck from '../components/ArticleDeck';
import type { Article } from '../types';

function article(overrides: Partial<Article> = {}): Article {
  return {
    id: 'a1',
    feedId: 'f1',
    feedName: 'Ars Technica',
    title: 'Apple unveils M5 chip',
    summary: 'A faster chip.',
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

function renderDeck(articles: Article[], over: Partial<Parameters<typeof ArticleDeck>[0]> = {}) {
  const props = {
    articles,
    loading: false,
    viewTitle: '今日',
    active: true,
    onBack: vi.fn(),
    onShowRows: vi.fn(),
    onOpen: vi.fn(),
    onToggleStar: vi.fn(),
    onRefresh: vi.fn(),
    onPlay: vi.fn(),
    currentEpisode: null,
    isPlaying: false,
    isBuffering: false,
    ...over,
  };
  render(<ArticleDeck {...props} />);
  return props;
}

describe('ArticleDeck', () => {
  it('draws one card per article plus the end card', () => {
    renderDeck([article(), article({ id: 'a2', title: 'Second' })]);
    expect(screen.getAllByRole('button', { name: /Apple unveils|Second/ })).toHaveLength(2);
    expect(screen.getByText('到底了 · 共 2 篇')).toBeTruthy();
    expect(screen.getByText('1 / 2')).toBeTruthy();
  });

  it('shows the summary on the card', () => {
    renderDeck([article()]);
    expect(screen.getByText('A faster chip.')).toBeTruthy();
  });

  // Unlike the rows, a card keeps the original under the translation.
  it('shows the translation first and the original under it', () => {
    renderDeck([article({ titleZh: '苹果发布 M5 芯片' })]);
    expect(screen.getByRole('heading', { name: '苹果发布 M5 芯片' })).toBeTruthy();
    expect(screen.getByText('Apple unveils M5 chip')).toBeTruthy();
  });

  it('a tap on the card opens it', () => {
    const a = article();
    const props = renderDeck([a]);
    fireEvent.click(screen.getByText('A faster chip.'));
    expect(props.onOpen).toHaveBeenCalledWith(a);
  });

  // Star and 原文 sit on the card: their taps must not also open the reader.
  it('star toggles without opening', () => {
    const a = article();
    const props = renderDeck([a]);
    fireEvent.click(screen.getByLabelText('收藏'));
    expect(props.onToggleStar).toHaveBeenCalledWith(a);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it('plays a podcast without opening', () => {
    const a = article({ audioUrl: 'https://x/a.mp3', audioDuration: '1:02:03' });
    const props = renderDeck([a]);
    fireEvent.click(screen.getByText('1:02:03'));
    expect(props.onPlay).toHaveBeenCalledWith(a);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  // Swiping is scrolling, and scrolling must never select: the reader panel would
  // fetch the full body of every card flicked past.
  it('scrolling moves the counter and opens nothing', () => {
    const props = renderDeck([article(), article({ id: 'a2' }), article({ id: 'a3' })]);
    const scroller = screen.getByTestId('deck-scroller');
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
    scroller.scrollTop = 1200;
    fireEvent.scroll(scroller);
    expect(screen.getByText('3 / 3')).toBeTruthy();
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it('hides the feed name on a single-feed view', () => {
    renderDeck([article()], { hideFeedName: true });
    expect(screen.queryByText('Ars Technica')).toBeNull();
  });

  it('empty list offers a reload', () => {
    const props = renderDeck([]);
    fireEvent.click(screen.getByText('重新加载'));
    expect(props.onRefresh).toHaveBeenCalled();
  });

  describe('arrow keys', () => {
    function scroller() {
      const el = screen.getByTestId('deck-scroller');
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: 600 });
      const scrollTo = vi.fn();
      el.scrollTo = scrollTo as unknown as typeof el.scrollTo;
      return scrollTo;
    }
    const three = () => [article(), article({ id: 'a2' }), article({ id: 'a3' })];

    it('↓ / ↑ page one card', () => {
      renderDeck(three());
      const scrollTo = scroller();
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 600, behavior: 'smooth' });
      fireEvent.keyDown(document, { key: 'ArrowUp' });
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });
    });

    // A second press during the smooth scroll must advance again, not re-aim at
    // the card the deck has not yet left.
    it('presses chain while the scroll is still moving', () => {
      renderDeck(three());
      const scrollTo = scroller();
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: 'smooth' });
    });

    it('stops at the end card and at the first card', () => {
      renderDeck([article()]);
      const scrollTo = scroller();
      fireEvent.keyDown(document, { key: 'ArrowUp' });
      expect(scrollTo).not.toHaveBeenCalled();
      fireEvent.keyDown(document, { key: 'ArrowDown' }); // → end card (index 1)
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    // Behind the reader, the arrows belong to nobody — the deck must not move.
    it('does nothing while the deck is not the panel on screen', () => {
      renderDeck(three(), { active: false });
      const scrollTo = scroller();
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it('leaves a focused text field alone', () => {
      renderDeck(three());
      const scrollTo = scroller();
      const input = document.createElement('input');
      document.body.appendChild(input);
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(scrollTo).not.toHaveBeenCalled();
      input.remove();
    });
  });

  it('the list button switches back to rows', () => {
    const props = renderDeck([article()]);
    fireEvent.click(screen.getByLabelText('列表模式'));
    expect(props.onShowRows).toHaveBeenCalled();
  });
});
