import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import ArticleReader from '../components/ArticleReader';

const noop = () => {};

const BASE_ARTICLE = {
  id: 'article-123',
  feedId: 'feed-1',
  feedName: 'Test Feed',
  title: 'Test Article Title',
  summary: 'Short article summary',
  content: '',
  link: 'https://example.com/article',
  pubDate: '2025-01-01T00:00:00Z',
  author: 'Test Author',
  isRead: true,
  isStarred: false,
  audioUrl: '',
  audioDuration: '',
};

function renderReader(article, overrides = {}) {
  return render(
    <ArticleReader
      article={article}
      isMobile={false}
      onBack={noop}
      onToggleStar={noop}
      onPlay={noop}
      currentEpisode={null}
      isPlaying={false}
      {...overrides}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── No article ────────────────────────────────────────────────────────────────

describe('no article', () => {
  it('shows empty state placeholder', () => {
    renderReader(null);
    expect(screen.getByText('选择一篇文章开始阅读')).toBeInTheDocument();
  });

  it('does not call fetch', () => {
    renderReader(null);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── Article with content (starred, from article_states) ───────────────────────

describe('article with content (starred)', () => {
  const article = { ...BASE_ARTICLE, content: '<p>Stored article content</p>', isStarred: true };

  it('does not fetch /api/articles/:id/content', () => {
    renderReader(article);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not show loading spinner', () => {
    renderReader(article);
    expect(screen.queryByText('加载中…')).not.toBeInTheDocument();
  });

  it('renders the stored content', () => {
    renderReader(article);
    expect(screen.getByText('Stored article content')).toBeInTheDocument();
  });
});

// ── Article without content (from list endpoint) ──────────────────────────────

describe('article without content (list endpoint)', () => {
  it('shows loading spinner immediately', () => {
    fetch.mockResolvedValue({ json: () => Promise.resolve({ content: '' }) });
    renderReader(BASE_ARTICLE);
    expect(screen.getByText('加载中…')).toBeInTheDocument();
  });

  it('fetches /api/articles/:id/content with correct feedId', async () => {
    fetch.mockResolvedValue({ json: () => Promise.resolve({ content: '' }) });
    renderReader(BASE_ARTICLE);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        `/api/articles/${BASE_ARTICLE.id}/content?feedId=${BASE_ARTICLE.feedId}`
      )
    );
  });

  it('hides spinner after content loads', async () => {
    fetch.mockResolvedValue({ json: () => Promise.resolve({ content: '<p>Fetched</p>' }) });
    renderReader(BASE_ARTICLE);
    await waitFor(() =>
      expect(screen.queryByText('加载中…')).not.toBeInTheDocument()
    );
  });

  it('renders content returned by the API', async () => {
    fetch.mockResolvedValue({ json: () => Promise.resolve({ content: '<p>Fetched content</p>' }) });
    renderReader(BASE_ARTICLE);
    await waitFor(() =>
      expect(screen.getByText('Fetched content')).toBeInTheDocument()
    );
  });

  it('falls back to summary when API returns empty content', async () => {
    fetch.mockResolvedValue({ json: () => Promise.resolve({ content: '' }) });
    renderReader(BASE_ARTICLE);
    await waitFor(() =>
      expect(screen.queryByText('加载中…')).not.toBeInTheDocument()
    );
    expect(screen.getByText(BASE_ARTICLE.summary)).toBeInTheDocument();
  });

  it('falls back to summary when fetch rejects', async () => {
    fetch.mockRejectedValue(new Error('Network error'));
    renderReader(BASE_ARTICLE);
    await waitFor(() =>
      expect(screen.queryByText('加载中…')).not.toBeInTheDocument()
    );
    expect(screen.getByText(BASE_ARTICLE.summary)).toBeInTheDocument();
  });
});

// ── Article metadata ──────────────────────────────────────────────────────────

describe('article metadata', () => {
  it('renders article title', () => {
    fetch.mockResolvedValue({ json: () => Promise.resolve({ content: '' }) });
    renderReader(BASE_ARTICLE);
    expect(screen.getByRole('heading', { name: BASE_ARTICLE.title })).toBeInTheDocument();
  });

  it('renders feed name', () => {
    fetch.mockResolvedValue({ json: () => Promise.resolve({ content: '' }) });
    renderReader(BASE_ARTICLE);
    expect(screen.getByText(BASE_ARTICLE.feedName)).toBeInTheDocument();
  });

  it('renders author name', () => {
    fetch.mockResolvedValue({ json: () => Promise.resolve({ content: '' }) });
    renderReader(BASE_ARTICLE);
    expect(screen.getByText(BASE_ARTICLE.author)).toBeInTheDocument();
  });
});
