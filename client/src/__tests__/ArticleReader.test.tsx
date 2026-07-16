import { render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

import ArticleReader, { stripMedia } from '../components/ArticleReader';
import { decodeEntities } from '../lib/decodeEntities';
import type { Article } from '../types';

const noop = () => {};

const BASE_ARTICLE: Article = {
  id: 'article-123',
  feedId: 'feed-1',
  feedName: 'Test Feed',
  title: 'Test Article Title',
  summary: 'Short article summary',
  content: '',
  link: 'https://example.com/article',
  pubDate: '2025-01-01T00:00:00Z',
  author: 'Test Author',
  isStarred: false,
  audioUrl: '',
  audioDuration: '',
};

let mockFetch: ReturnType<typeof vi.fn>;

function renderReader(
  article: Article | null,
  overrides: Partial<ComponentProps<typeof ArticleReader>> = {},
) {
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
    />,
  );
}

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
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
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── Article with content (starred, from article_states) ───────────────────────

describe('article with content (starred)', () => {
  const article: Article = {
    ...BASE_ARTICLE,
    content: '<p>Stored article content</p>',
    isStarred: true,
  };

  it('does not fetch /api/articles/:id/content', () => {
    renderReader(article);
    expect(mockFetch).not.toHaveBeenCalled();
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
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ content: '' }) });
    renderReader(BASE_ARTICLE);
    expect(screen.getByText('加载中…')).toBeInTheDocument();
  });

  it('fetches /api/articles/:id/content with correct feedId', async () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ content: '' }) });
    renderReader(BASE_ARTICLE);
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/articles/${BASE_ARTICLE.id}/content?feedId=${BASE_ARTICLE.feedId}`,
      ),
    );
  });

  it('hides spinner after content loads', async () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ content: '<p>Fetched</p>' }) });
    renderReader(BASE_ARTICLE);
    await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
  });

  it('renders content returned by the API', async () => {
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ content: '<p>Fetched content</p>' }),
    });
    renderReader(BASE_ARTICLE);
    await waitFor(() => expect(screen.getByText('Fetched content')).toBeInTheDocument());
  });

  it('falls back to summary when API returns empty content', async () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ content: '' }) });
    renderReader(BASE_ARTICLE);
    await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
    expect(screen.getByText(BASE_ARTICLE.summary)).toBeInTheDocument();
  });

  it('falls back to summary when fetch rejects', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    renderReader(BASE_ARTICLE);
    await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
    expect(screen.getByText(BASE_ARTICLE.summary)).toBeInTheDocument();
  });
});

// ── Article metadata ──────────────────────────────────────────────────────────

describe('article metadata', () => {
  it('renders article title', () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ content: '' }) });
    renderReader(BASE_ARTICLE);
    expect(screen.getByRole('heading', { name: BASE_ARTICLE.title })).toBeInTheDocument();
  });

  it('renders feed name', () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ content: '' }) });
    renderReader(BASE_ARTICLE);
    expect(screen.getByText(BASE_ARTICLE.feedName)).toBeInTheDocument();
  });

  it('renders author name', () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ content: '' }) });
    renderReader(BASE_ARTICLE);
    expect(screen.getByText(BASE_ARTICLE.author)).toBeInTheDocument();
  });
});

// ── 无图模式 (text-only) ───────────────────────────────────────────────────────

describe('stripMedia', () => {
  it('removes images while preserving text content', () => {
    const html = '<p>Before</p><img src="x.jpg" alt="x"><p>After</p>';
    const out = stripMedia(html);
    expect(out).not.toContain('<img');
    expect(out).toContain('Before');
    expect(out).toContain('After');
  });

  it('removes figures, videos, iframes, and embeds', () => {
    const html =
      '<figure><img src="x.jpg"><figcaption>cap</figcaption></figure>' +
      '<video src="v.mp4"></video><iframe src="e.html"></iframe>' +
      '<embed src="o.swf"><svg><circle /></svg><p>keep</p>';
    const out = stripMedia(html);
    for (const tag of ['<figure', '<figcaption', '<video', '<iframe', '<embed', '<svg']) {
      expect(out).not.toContain(tag);
    }
    expect(out).toContain('keep');
  });

  it('leaves real content (links, code, blockquotes) untouched', () => {
    const html =
      '<p><a href="/x">link</a></p><pre><code>code</code></pre><blockquote>quote</blockquote>';
    expect(stripMedia(html)).toBe(html);
  });
});

describe('decodeEntities', () => {
  it('decodes numeric character references in tag-less text', () => {
    expect(decodeEntities('just&#160;don&#8217;t&#160;have')).toBe('just don’t have');
  });

  it('decodes an ellipsis entity', () => {
    expect(decodeEntities('a [&#8230;]')).toBe('a […]');
  });
});

describe('plain-text content renders decoded entities', () => {
  it('decodes entities when content has no HTML tags', async () => {
    const article: Article = {
      ...BASE_ARTICLE,
      content: 'just&#160;don&#8217;t&#160;have&#160;it',
    };
    renderReader(article);
    await waitFor(() => expect(screen.getByText('just don’t have it')).toBeInTheDocument());
    expect(screen.queryByText(/&#160;|&#8217;/)).not.toBeInTheDocument();
  });
});

describe('article title renders decoded entities', () => {
  it('decodes entities in the title heading', async () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ content: '' }) });
    const article: Article = {
      ...BASE_ARTICLE,
      title: 'Samsung&#8217;s Galaxy Z Flip 8 leaks',
    };
    renderReader(article);
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Samsung’s Galaxy Z Flip 8 leaks' }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/&#8217;/)).not.toBeInTheDocument();
  });
});

describe('WeChat-pasted inline styles', () => {
  it('strips inline style attributes so the reader typography governs', async () => {
    const article: Article = {
      ...BASE_ARTICLE,
      content:
        '<p style="text-align: justify; letter-spacing: 1.5px; font-size: 15px; ' +
        "font-family: 'PingFang SC'; color: rgba(0, 0, 0, 0.9); background-color: #ffffff;\">" +
        '与此同时 <b>Bloomberg Index</b></p>',
    };
    const { container } = renderReader(article);
    await waitFor(() => expect(screen.getByText(/与此同时/)).toBeInTheDocument());

    const p = container.querySelector('.rss-article p')!;
    // No inline styling survives — no justify stretch, no baked-in colors (dark-mode safe)
    expect(p.getAttribute('style')).toBeNull();
    // Text and tag-based emphasis are preserved
    expect(p.querySelector('b')).not.toBeNull();
    expect(p.textContent).toContain('Bloomberg Index');
  });

  it('keeps img width/height attributes for aspect-ratio while dropping inline style', async () => {
    const article: Article = {
      ...BASE_ARTICLE,
      content:
        '<p style="text-align:center"><img src="https://example.com/x.png" ' +
        'style="width: 644.938px !important; height: auto !important;" width="1080" height="393"></p>',
    };
    const { container } = renderReader(article);
    await waitFor(() => expect(container.querySelector('.rss-article img')).not.toBeNull());

    const img = container.querySelector('.rss-article img')!;
    expect(img.getAttribute('width')).toBe('1080');
    expect(img.getAttribute('height')).toBe('393');
    // The runaway inline pixel width is gone; the reader CSS (max-width:100%) can size it
    expect(img.getAttribute('style')).not.toContain('644');
  });
});

describe('text-only toggle', () => {
  beforeEach(() => localStorage.removeItem('text-only'));
  afterEach(() => localStorage.removeItem('text-only'));

  it('strips images from the rendered body when enabled', async () => {
    const article: Article = {
      ...BASE_ARTICLE,
      content: '<p>Body text</p><img src="https://example.com/x.jpg" alt="pic">',
    };
    const { container } = renderReader(article);
    await waitFor(() => expect(screen.getByText('Body text')).toBeInTheDocument());

    // Default: image present
    expect(container.querySelector('.rss-article img')).not.toBeNull();

    // Enable 无图模式 via the toolbar toggle
    screen.getByTitle('无图模式').click();
    await waitFor(() => expect(container.querySelector('.rss-article img')).toBeNull());
    expect(screen.getByText('Body text')).toBeInTheDocument();
  });

  it('reads the persisted preference from localStorage on mount', async () => {
    localStorage.setItem('text-only', '1');
    const article: Article = {
      ...BASE_ARTICLE,
      content: '<p>Body text</p><img src="https://example.com/x.jpg" alt="pic">',
    };
    const { container } = renderReader(article);
    await waitFor(() => expect(screen.getByText('Body text')).toBeInTheDocument());
    expect(container.querySelector('.rss-article img')).toBeNull();
    // Toggle reflects the active state — button offers to show images again
    expect(screen.getByTitle('显示图片')).toBeInTheDocument();
  });
});
