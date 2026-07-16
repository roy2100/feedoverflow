import {
  Star,
  AlignLeft,
  Mic,
  Play,
  Pause,
  ChevronLeft,
  Maximize2,
  Minimize2,
  Image,
  ImageOff,
  Check,
} from 'lucide-react';
import { useState, useEffect, useRef } from 'react';

import { decodeEntities } from '../lib/decodeEntities';
import type { Article } from '../types';

// null = nothing fetched, 'loading' = in flight, object = result (full HTML or an error)
type FullContent = null | 'loading' | { html: string } | { error: string };

function formatFullDate(dateStr: string | number): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Split a comma-separated byline into trimmed names (handles ASCII + full-width commas).
function splitAuthors(author: string): string[] {
  return author
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Normalize a byline ("A,B,C" → "A · B · C") so multi-author feeds read cleanly.
function formatAuthor(author: string): string {
  return splitAuthors(author).join(' · ');
}

// Collapse long multi-author bylines: show the first MAX_AUTHORS names, then "等".
// The full list stays available via the title tooltip.
const MAX_AUTHORS = 2;
function truncateAuthor(author: string): string {
  const names = splitAuthors(author);
  if (names.length <= MAX_AUTHORS) return names.join(' · ');
  return `${names.slice(0, MAX_AUTHORS).join(' · ')} 等`;
}

interface ArticleReaderProps {
  isMobile?: boolean;
  onBack?: () => void;
  article: Article | null;
  onToggleStar: (article: Article) => void;
  onPlay: (article: Article) => void;
  currentEpisode: Article | null;
  isPlaying: boolean;
  scrollRef?: React.RefObject<HTMLDivElement>;
  readingMode?: boolean;
  onToggleReadingMode?: () => void;
}

export default function ArticleReader({
  isMobile,
  onBack,
  article,
  onToggleStar,
  onPlay,
  currentEpisode,
  isPlaying,
  scrollRef,
  readingMode,
  onToggleReadingMode,
}: ArticleReaderProps) {
  const [fullContent, setFullContent] = useState<FullContent>(null);
  // null = loading, string = done (may be empty)
  // Initialise with article.content so starred articles avoid a spinner flash on mount
  const [rssContent, setRssContent] = useState<string | null>(() => article?.content || null);
  // 无图模式 — strips images/media from the article body for distraction-free reading.
  // Display-only and self-contained (unlike readingMode, which changes the App layout).
  const [textOnly, setTextOnly] = useState(() => localStorage.getItem('text-only') === '1');
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem('text-only', textOnly ? '1' : '0');
  }, [textOnly]);

  useEffect(() => {
    setFullContent(null);
    if (!article) {
      setRssContent(null);
      return;
    }
    if (article.content) {
      // starred articles already carry content from article_states
      setRssContent(article.content);
    } else {
      setRssContent(null);
      fetch(`/api/articles/${article.id}/content?feedId=${article.feedId}`)
        .then((r) => r.json())
        .then((d) => setRssContent(d.content || ''))
        .catch(() => setRssContent(''));
    }
  }, [article?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Post-process rendered article images: lazy-load + decode off the main
  // thread, and reserve vertical space ahead of load to avoid text reflow.
  // When the source markup carries width/height, we pin the intrinsic
  // aspect-ratio so the browser lays out the (still responsive) box before
  // the bytes arrive — no jump when the image finally paints.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    root.querySelectorAll('img').forEach((img) => {
      img.loading = 'lazy';
      img.decoding = 'async';
      const w = Number(img.getAttribute('width'));
      const h = Number(img.getAttribute('height'));
      if (w > 0 && h > 0) img.style.aspectRatio = `${w} / ${h}`;
    });
    // Feed-supplied links navigate in-place by default. In an iOS standalone
    // PWA that leaves the app's own webview and returns via back-navigation,
    // which triggers a WebKit layout bug (blank strip at the bottom). Forcing
    // a new tab/external browser sidesteps that navigation entirely.
    root.querySelectorAll('a[href]').forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
  }, [article?.id, rssContent, fullContent, textOnly]);

  const handleFetchFull = async () => {
    if (!article?.link) return;
    setFullContent('loading');
    try {
      const r = await fetch(`/api/fetch-content?url=${encodeURIComponent(article.link)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'failed');
      setFullContent({ html: data.content });
    } catch (err) {
      setFullContent({ error: (err as Error).message });
    }
  };

  if (!article) {
    if (isMobile) return null;
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-reader)',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none" opacity="0.15">
          <rect x="8" y="10" width="32" height="28" rx="3" stroke="#141210" strokeWidth="2" />
          <path
            d="M14 18h20M14 24h20M14 30h12"
            stroke="#141210"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>选择一篇文章开始阅读</p>
      </div>
    );
  }

  const fullHtml =
    fullContent && fullContent !== 'loading' && 'html' in fullContent ? fullContent.html : null;
  const fullError =
    fullContent && fullContent !== 'loading' && 'error' in fullContent ? fullContent.error : null;

  const isLoadingContent = rssContent === null;
  const rawContent = fullHtml || rssContent || article.summary || '';
  const hasHtml = /<[a-z][\s\S]*>/i.test(rawContent);

  return (
    <div
      ref={scrollRef}
      key={article.id}
      tabIndex={-1}
      className="reader-selectable"
      style={{
        flex: 1,
        background: 'var(--bg-reader)',
        overflowY: 'auto',
        outline: 'none',
        overflowX: 'hidden',
        WebkitOverflowScrolling: 'touch',
        animation: 'fadeIn 0.2s ease',
        display: 'flex',
        flexDirection: 'column',
        height: isMobile ? '100%' : undefined,
      }}
    >
      {/* Mobile back header */}
      {isMobile && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '0 12px',
            height: 52,
            flexShrink: 0,
            borderBottom: '1px solid var(--border-light)',
            background: 'var(--bg-reader)',
            position: 'sticky',
            top: 0,
            zIndex: 10,
          }}
        >
          <button
            onClick={onBack}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              color: 'var(--accent)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '6px 8px 6px 0',
              fontSize: 15,
              flexShrink: 0,
            }}
          >
            <ChevronLeft size={20} strokeWidth={2} />
            文章列表
          </button>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => onToggleStar(article)}
            aria-label={article.isStarred ? '取消收藏' : '收藏'}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: article.isStarred ? '#F5C518' : 'var(--text-tertiary)',
              display: 'flex',
              alignItems: 'center',
              padding: 6,
              borderRadius: 5,
            }}
          >
            <Star size={18} fill={article.isStarred ? '#F5C518' : 'none'} strokeWidth={1.5} />
          </button>
          <button
            onClick={() => setTextOnly((v) => !v)}
            aria-label={textOnly ? '显示图片' : '无图模式'}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: textOnly ? 'var(--accent)' : 'var(--text-tertiary)',
              display: 'flex',
              alignItems: 'center',
              padding: 6,
              borderRadius: 5,
            }}
          >
            {textOnly ? (
              <ImageOff size={18} strokeWidth={1.5} />
            ) : (
              <Image size={18} strokeWidth={1.5} />
            )}
          </button>
          {article.link && (
            <a
              href={article.link}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 3,
                fontSize: 13,
                color: 'var(--accent)',
                textDecoration: 'none',
                padding: 6,
              }}
            >
              原文
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                <path
                  d="M2 10L10 2M10 2H5M10 2v5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
          )}
        </div>
      )}

      <div
        style={{
          maxWidth: readingMode ? 820 : 680,
          width: '100%',
          margin: '0 auto',
          padding: isMobile ? '24px 20px 80px' : '48px 48px 80px',
        }}
      >
        {/* Feed name */}
        {article.feedName && (
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--accent)',
              marginBottom: 12,
            }}
          >
            {article.feedName}
          </div>
        )}

        {/* Title */}
        <h1
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: isMobile ? 22 : 'clamp(22px, 3vw, 28px)',
            fontWeight: 600,
            lineHeight: 1.35,
            color: 'var(--text-primary)',
            marginBottom: 14,
            letterSpacing: '-0.01em',
          }}
        >
          {decodeEntities(article.title)}
        </h1>

        {/* Meta */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: isMobile ? 10 : 16,
            marginBottom: 32,
            paddingBottom: 12,
            borderBottom: '1px solid var(--border-light)',
            flexWrap: 'wrap',
          }}
        >
          {/* Byline + date — one wrapping group so actions stay aligned right */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '4px 10px',
              minWidth: 0,
              flex: '1 1 auto',
            }}
          >
            {article.author && (
              <span
                title={formatAuthor(article.author)}
                style={{
                  fontSize: 12.5,
                  color: 'var(--text-secondary)',
                  fontWeight: 500,
                  letterSpacing: '0.01em',
                  maxWidth: isMobile ? '100%' : 360,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {truncateAuthor(article.author)}
              </span>
            )}
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
              {formatFullDate(article.pubDate)}
            </span>
            {article.updatedAt && (
              <span
                title={`内容更新于 ${formatFullDate(article.updatedAt)}`}
                style={{ fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}
              >
                更新于 {formatFullDate(article.updatedAt)}
              </span>
            )}
          </div>
          {/* Desktop-only actions */}
          {!isMobile && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={() => onToggleStar(article)}
                title={article.isStarred ? '取消收藏' : '收藏'}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: article.isStarred ? '#F5C518' : 'var(--text-tertiary)',
                  display: 'flex',
                  alignItems: 'center',
                  padding: 4,
                  borderRadius: 5,
                  transition: 'color 0.15s',
                }}
                onMouseEnter={(e) => {
                  if (!article.isStarred) e.currentTarget.style.color = '#F5C518';
                }}
                onMouseLeave={(e) => {
                  if (!article.isStarred) e.currentTarget.style.color = 'var(--text-tertiary)';
                }}
              >
                <Star size={15} fill={article.isStarred ? '#F5C518' : 'none'} strokeWidth={1.5} />
              </button>
              <button
                onClick={() => setTextOnly((v) => !v)}
                title={textOnly ? '显示图片' : '无图模式'}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: textOnly ? 'var(--accent)' : 'var(--text-tertiary)',
                  display: 'flex',
                  alignItems: 'center',
                  padding: 4,
                  borderRadius: 5,
                  transition: 'color 0.15s',
                }}
                onMouseEnter={(e) => {
                  if (!textOnly) e.currentTarget.style.color = 'var(--accent)';
                }}
                onMouseLeave={(e) => {
                  if (!textOnly) e.currentTarget.style.color = 'var(--text-tertiary)';
                }}
              >
                {textOnly ? (
                  <ImageOff size={15} strokeWidth={1.5} />
                ) : (
                  <Image size={15} strokeWidth={1.5} />
                )}
              </button>
              {onToggleReadingMode && (
                <button
                  onClick={onToggleReadingMode}
                  title={readingMode ? '退出专注阅读 (Esc)' : '专注阅读'}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: readingMode ? 'var(--accent)' : 'var(--text-tertiary)',
                    display: 'flex',
                    alignItems: 'center',
                    padding: 4,
                    borderRadius: 5,
                    transition: 'color 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    if (!readingMode) e.currentTarget.style.color = 'var(--accent)';
                  }}
                  onMouseLeave={(e) => {
                    if (!readingMode) e.currentTarget.style.color = 'var(--text-tertiary)';
                  }}
                >
                  {readingMode ? (
                    <Minimize2 size={15} strokeWidth={1.5} />
                  ) : (
                    <Maximize2 size={15} strokeWidth={1.5} />
                  )}
                </button>
              )}
              {article.link && !fullContent && (
                <button
                  onClick={handleFetchFull}
                  title="从原始网页提取全文"
                  style={{
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                    background: 'none',
                    border: '1px solid var(--border)',
                    borderRadius: 5,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '3px 8px',
                    transition: 'color 0.15s, border-color 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = 'var(--accent)';
                    e.currentTarget.style.borderColor = 'var(--accent)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = 'var(--text-tertiary)';
                    e.currentTarget.style.borderColor = 'var(--border)';
                  }}
                >
                  <AlignLeft size={11} />
                  全文
                </button>
              )}
              {fullContent === 'loading' && (
                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <span
                    style={{
                      width: 11,
                      height: 11,
                      border: '1.5px solid var(--border)',
                      borderTopColor: 'var(--accent)',
                      borderRadius: '50%',
                      display: 'inline-block',
                      animation: 'spin 0.8s linear infinite',
                    }}
                  />
                  加载中…
                </span>
              )}
              {fullHtml && (
                <button
                  onClick={() => setFullContent(null)}
                  title="恢复 RSS 原文"
                  style={{
                    fontSize: 12,
                    color: 'var(--accent)',
                    background: 'none',
                    border: '1px solid var(--accent)',
                    borderRadius: 5,
                    cursor: 'pointer',
                    padding: '3px 8px',
                    opacity: 0.7,
                    transition: 'opacity 0.15s',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
                >
                  <Check size={11} />
                  全文
                </button>
              )}
              {article.link && (
                <a
                  href={article.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 12,
                    color: 'var(--accent)',
                    textDecoration: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    opacity: 0.8,
                    transition: 'opacity 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.8')}
                >
                  原文
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M2 10L10 2M10 2H5M10 2v5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </a>
              )}
            </div>
          )}
          {/* Mobile: load full content button */}
          {isMobile && article.link && !fullContent && (
            <button
              onClick={handleFetchFull}
              style={{
                fontSize: 12,
                color: 'var(--text-tertiary)',
                background: 'none',
                border: '1px solid var(--border)',
                borderRadius: 5,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 8px',
              }}
            >
              <AlignLeft size={11} />
              全文
            </button>
          )}
          {isMobile && fullContent === 'loading' && (
            <span
              style={{
                fontSize: 12,
                color: 'var(--text-tertiary)',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span
                style={{
                  width: 11,
                  height: 11,
                  border: '1.5px solid var(--border)',
                  borderTopColor: 'var(--accent)',
                  borderRadius: '50%',
                  display: 'inline-block',
                  animation: 'spin 0.8s linear infinite',
                }}
              />
              加载中…
            </span>
          )}
          {isMobile && fullHtml && (
            <button
              onClick={() => setFullContent(null)}
              title="恢复 RSS 原文"
              style={{
                fontSize: 12,
                color: 'var(--accent)',
                background: 'none',
                border: '1px solid var(--accent)',
                borderRadius: 5,
                cursor: 'pointer',
                padding: '3px 8px',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <Check size={11} />
              全文
            </button>
          )}
        </div>

        {/* Podcast play button */}
        {article.audioUrl && (
          <div
            style={{
              marginBottom: 32,
              padding: '12px 16px',
              background: 'var(--bg-panel)',
              borderRadius: 8,
              border: '1px solid var(--border-light)',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <Mic
              size={13}
              strokeWidth={2}
              style={{ color: 'var(--accent-light)', flexShrink: 0 }}
            />
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 500 }}>
              播客{article.audioDuration ? ` · ${article.audioDuration}` : ''}
            </span>
            <button
              onClick={() => onPlay(article)}
              style={{
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--accent)',
                padding: '4px 10px',
                borderRadius: 5,
                border: '1px solid var(--accent)',
                background: 'none',
                cursor: 'pointer',
                transition: 'background 0.12s',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            >
              {currentEpisode?.id === article.id && isPlaying ? (
                <>
                  <Pause size={11} strokeWidth={2} /> 暂停
                </>
              ) : currentEpisode?.id === article.id ? (
                <>
                  <Play size={11} strokeWidth={2} /> 继续
                </>
              ) : (
                <>
                  <Play size={11} strokeWidth={2} /> 播放
                </>
              )}
            </button>
          </div>
        )}

        {/* Content */}
        {fullError ? (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '20px 0' }}>
            加载失败：{fullError}。
            <button
              onClick={() => setFullContent(null)}
              style={{
                marginLeft: 8,
                color: 'var(--accent)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              重置
            </button>
          </div>
        ) : isLoadingContent ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '20px 0',
              color: 'var(--text-tertiary)',
              fontSize: 13,
            }}
          >
            <span
              style={{
                width: 12,
                height: 12,
                border: '1.5px solid var(--border)',
                borderTopColor: 'var(--accent)',
                borderRadius: '50%',
                display: 'inline-block',
                animation: 'spin 0.8s linear infinite',
              }}
            />
            加载中…
          </div>
        ) : hasHtml ? (
          <div
            ref={contentRef}
            className="rss-article"
            style={articleContentStyle}
            dangerouslySetInnerHTML={{
              __html: textOnly ? stripMedia(sanitizeHtml(rawContent)) : sanitizeHtml(rawContent),
            }}
          />
        ) : (
          <div className="rss-article" style={articleContentStyle}>
            {decodeEntities(rawContent)
              .split('\n')
              .filter(Boolean)
              .map((p, i) => (
                <p key={i}>{p}</p>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Tags removed in 无图模式 — images and other non-text "content-irrelevant" elements.
const MEDIA_SELECTOR =
  'img, picture, source, figure, figcaption, video, audio, iframe, embed, object, svg';

// Strip media via the browser-native DOM parser (robust against nested/malformed markup,
// no dependency). Falls back to the input where DOMParser is unavailable (non-browser).
export function stripMedia(html: string): string {
  if (typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(MEDIA_SELECTOR).forEach((el) => el.remove());
  return doc.body.innerHTML;
}

function sanitizeHtml(html: string): string {
  return (
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/on\w+="[^"]*"/gi, '')
      .replace(/on\w+='[^']*'/gi, '')
      // Drop inline style attributes. Feed HTML (esp. WeChat/公众号-pasted articles)
      // ships every element with hardcoded typography — fixed font-size/line-height,
      // letter-spacing, font-family, text-align: justify, pixel widths — and, worse,
      // baked-in `color: rgba(0,0,0,.9)` / `background-color: #fff` that render as
      // black-on-dark in dark mode. Stripping them lets the reader's own .rss-article
      // stylesheet fully govern, so every article reads consistently and theme-correctly.
      // (Emphasis via <b>/<strong>/<i>/<em>/<h2>… tags survives and gets themed.)
      .replace(/\sstyle\s*=\s*"[^"]*"/gi, '')
      .replace(/\sstyle\s*=\s*'[^']*'/gi, '')
  );
}

const articleContentStyle: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontSize: 16,
  lineHeight: 1.85,
  color: 'var(--text-primary)',
};

if (typeof document !== 'undefined') {
  const id = 'rss-article-styles';
  if (!document.getElementById(id)) {
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      .rss-article p { margin-bottom: 1.1em; }
      .rss-article h1, .rss-article h2, .rss-article h3 {
        font-family: var(--font-serif);
        font-weight: 600;
        margin-top: 1.6em;
        margin-bottom: 0.6em;
        line-height: 1.3;
        color: var(--text-primary);
      }
      .rss-article h1 { font-size: 1.4em; }
      .rss-article h2 { font-size: 1.2em; }
      .rss-article h3 { font-size: 1.05em; }
      .rss-article a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
      .rss-article img, .rss-article video, .rss-article iframe, .rss-article embed { max-width: 100%; height: auto; }
      .rss-article img { border-radius: 6px; margin: 1em 0; }
      .rss-article table { max-width: 100%; overflow-x: auto; display: block; }
      .rss-article blockquote {
        border-left: 3px solid var(--accent);
        margin: 1.2em 0;
        padding: 0.4em 0 0.4em 1.2em;
        color: var(--text-secondary);
        font-style: italic;
      }
      .rss-article pre, .rss-article code {
        font-family: 'SF Mono', 'Fira Mono', monospace;
        font-size: 0.88em;
        background: var(--bg-panel);
        border-radius: 4px;
      }
      .rss-article pre { padding: 1em; overflow-x: auto; margin: 1em 0; }
      .rss-article code { padding: 0.1em 0.3em; }
      .rss-article ul, .rss-article ol { padding-left: 1.4em; margin: 0.8em 0; }
      .rss-article li { margin-bottom: 0.3em; }
      .rss-article figure { margin: 1.2em 0; }
      .rss-article figcaption { font-size: 0.85em; color: var(--text-tertiary); text-align: center; margin-top: 4px; }
    `;
    document.head.appendChild(style);
  }
}
