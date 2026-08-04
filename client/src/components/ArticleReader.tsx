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
  Copy,
  MoreHorizontal,
  Loader2,
} from 'lucide-react';
import { useState, useEffect, useRef, useSyncExternalStore } from 'react';

import { decodeEntities } from '../lib/decodeEntities';
import { hasProgress, subscribeProgress } from '../lib/playbackProgress';
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

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Meta-row date: drops the year for the current year ("7月27日 18:13"), which is what
// makes the row fit — two unshrinkable full dates crowd the byline out entirely on a
// narrow reader pane. Full precision stays in the title tooltip.
function formatMetaDate(dateStr: string | number): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${hhmm(d)}`;
}

// A content update on the publication day repeats the date verbatim; show only the
// time in that case.
function formatUpdated(pubDate: string | number, updatedAt: string | number): string {
  const pub = new Date(pubDate);
  const upd = new Date(updatedAt);
  if (isNaN(upd.getTime())) return '';
  if (!isNaN(pub.getTime()) && isSameDay(pub, upd)) return hhmm(upd);
  return formatMetaDate(updatedAt);
}

// Split a comma-separated byline into trimmed names (handles ASCII + full-width commas).
function splitAuthors(author: string): string[] {
  return author
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Normalize a byline ("A,B,C" → "A · B · C") so multi-author feeds read cleanly.
// No name-count cap: the byline renders in full and the flex row truncates it with a
// CSS ellipsis only when it genuinely runs out of width. The full list stays available
// via the title tooltip.
function formatAuthor(author: string): string {
  return splitAuthors(author).join(' · ');
}

interface ActionItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  onSelect: () => void;
  /** Renders a ✓ on the right — for the toggles, whose state is otherwise invisible. */
  active?: boolean;
  disabled?: boolean;
  /** Keep the menu open this long after the click, so an item can show its own result. */
  holdOpenMs?: number;
}

// Overflow menu for the reader's low-frequency actions. Copy/无图/专注 are all rare
// (无图 is a preference you set once), and each cost a permanent icon slot in a row
// that has to share its width with the byline. Folded into one ⋯ they also get real
// labels instead of hover-only tooltips.
function ActionMenu({ items, iconSize }: { items: ActionItem[]; iconSize: number }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // Capture phase + stopPropagation so Esc closes the menu without also reaching
    // App's document-level handler, which would exit 专注阅读 in the same keystroke.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const select = (item: ActionItem) => {
    item.onSelect();
    clearTimeout(closeTimer.current);
    if (item.holdOpenMs) {
      closeTimer.current = setTimeout(() => setOpen(false), item.holdOpenMs);
    } else {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        title="更多操作"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: open ? 'var(--accent)' : 'var(--text-tertiary)',
          display: 'flex',
          alignItems: 'center',
          padding: iconSize > 15 ? 6 : 4,
          borderRadius: 5,
          transition: 'color 0.15s',
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.color = 'var(--accent)';
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.color = 'var(--text-tertiary)';
        }}
      >
        <MoreHorizontal size={iconSize} strokeWidth={1.5} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 152,
            padding: 4,
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-light)',
            borderRadius: 8,
            boxShadow: '0 12px 32px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06)',
            zIndex: 30,
            animation: 'fadeIn 0.12s ease',
          }}
        >
          {items.map((item) => (
            <button
              key={item.key}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => select(item)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 9px',
                fontSize: 12.5,
                textAlign: 'left',
                whiteSpace: 'nowrap',
                background: 'none',
                border: 'none',
                borderRadius: 5,
                color: 'var(--text-secondary)',
                opacity: item.disabled ? 0.4 : 1,
                cursor: item.disabled ? 'default' : 'pointer',
                transition: 'background 0.12s',
              }}
              onMouseEnter={(e) => {
                if (!item.disabled) e.currentTarget.style.background = 'var(--bg-hover)';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            >
              {item.icon}
              {item.label}
              {item.active && (
                <Check
                  size={12}
                  strokeWidth={2}
                  style={{ marginLeft: 'auto', color: 'var(--accent)' }}
                />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface ArticleReaderProps {
  isMobile?: boolean;
  onBack?: () => void;
  article: Article | null;
  onToggleStar: (article: Article) => void;
  onPlay: (article: Article) => void;
  currentEpisode: Article | null;
  isPlaying: boolean;
  isBuffering: boolean;
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
  isBuffering,
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
  // Transient feedback for the copy button; reset by a timer we own so switching
  // articles mid-flash can't leave a stale "已复制".
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'fail'>('idle');
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem('text-only', textOnly ? '1' : '0');
  }, [textOnly]);

  useEffect(() => {
    setCopyState('idle');
    clearTimeout(copyTimer.current);
  }, [article?.id]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

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

  // Copies whatever the reader is currently showing — the extracted 全文 when it has
  // been loaded, otherwise the RSS body — as plain text, with the title and source URL
  // so a pasted article keeps its provenance.
  const handleCopy = async () => {
    if (!article) return;
    const extracted =
      fullContent && fullContent !== 'loading' && 'html' in fullContent ? fullContent.html : '';
    const body = htmlToPlainText(extracted || rssContent || article.summary || '');
    const text = [decodeEntities(article.title), body, article.link && `原文：${article.link}`]
      .filter(Boolean)
      .join('\n\n');
    clearTimeout(copyTimer.current);
    setCopyState((await copyText(text)) ? 'done' : 'fail');
    copyTimer.current = setTimeout(() => setCopyState('idle'), 1800);
  };

  // Subscribed rather than read straight off the map: the positions arrive from
  // SQLite one fetch after the first paint, so a reader already open would keep
  // offering 播放 on an episode it could resume.
  const canResume = useSyncExternalStore(subscribeProgress, () =>
    article ? hasProgress(article.id) : false,
  );

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

  const menuIcon = 14;
  const menuItems: ActionItem[] = [
    {
      key: 'copy',
      icon:
        copyState === 'done' ? (
          <Check size={menuIcon} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
        ) : (
          <Copy size={menuIcon} strokeWidth={1.5} />
        ),
      label: copyState === 'done' ? '已复制' : copyState === 'fail' ? '复制失败' : '复制全文',
      onSelect: handleCopy,
      disabled: isLoadingContent,
      // Stay open long enough for the label to report the result — closing on click
      // would take the only feedback the action has with it.
      holdOpenMs: 1000,
    },
    {
      key: 'text-only',
      icon: textOnly ? (
        <ImageOff size={menuIcon} strokeWidth={1.5} />
      ) : (
        <Image size={menuIcon} strokeWidth={1.5} />
      ),
      label: '无图模式',
      active: textOnly,
      onSelect: () => setTextOnly((v) => !v),
    },
  ];
  if (onToggleReadingMode) {
    menuItems.push({
      key: 'reading-mode',
      icon: readingMode ? (
        <Minimize2 size={menuIcon} strokeWidth={1.5} />
      ) : (
        <Maximize2 size={menuIcon} strokeWidth={1.5} />
      ),
      label: '专注阅读',
      active: readingMode,
      onSelect: onToggleReadingMode,
    });
  }

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
          <ActionMenu items={menuItems} iconSize={18} />
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
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path
                  d="M2 10L10 2M10 2H5M10 2v5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              原文
            </a>
          )}
        </div>
      )}

      <div
        style={{
          maxWidth: readingMode ? 820 : 680,
          width: '100%',
          margin: '0 auto',
          // Horizontal padding scales with the pane: a fixed 48px eats a third of a
          // narrow (un-maximized) reader column, so it only reaches 48 once the pane
          // is wide enough to spare it.
          padding: isMobile ? '20px 20px 72px' : '32px clamp(24px, 5%, 48px) 72px',
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
              marginBottom: 10,
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
            marginBottom: 12,
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
            // The body's own line-height (1.85) already adds ~7px of half-leading above
            // the first line, so the visual gap under the rule reads larger than this.
            marginBottom: 20,
            paddingBottom: 10,
            borderBottom: '1px solid var(--border-light)',
            // Desktop keeps byline and actions on one line: with `wrap`, flex breaks
            // lines on content size *before* shrinking, so the actions group jumped to
            // its own row even though the byline can truncate. `nowrap` lets it shrink.
            flexWrap: isMobile ? 'wrap' : 'nowrap',
          }}
        >
          {/* Byline + date — one group so actions stay aligned right */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: isMobile ? 'wrap' : 'nowrap',
              gap: '4px 10px',
              minWidth: 0,
              overflow: 'hidden',
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
                  // minWidth: 0 overrides the automatic minimum size, without which a
                  // nowrap span refuses to shrink and would push the actions out.
                  minWidth: 0,
                  // Outweighs the dates' shrink factor, so the byline (which has a
                  // tooltip) absorbs the squeeze and the dates only give way once it
                  // is fully collapsed.
                  flexShrink: 100,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {formatAuthor(article.author)}
              </span>
            )}
            {formatMetaDate(article.pubDate) && (
              <span title={formatFullDate(article.pubDate)} style={metaDateStyle}>
                {formatMetaDate(article.pubDate)}
              </span>
            )}
            {article.updatedAt && formatUpdated(article.pubDate, article.updatedAt) && (
              <span title={`内容更新于 ${formatFullDate(article.updatedAt)}`} style={metaDateStyle}>
                更新于 {formatUpdated(article.pubDate, article.updatedAt)}
              </span>
            )}
          </div>
          {/* Desktop-only actions */}
          {!isMobile && (
            <div
              style={{
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexShrink: 0,
              }}
            >
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
              <ActionMenu items={menuItems} iconSize={15} />
              {article.link && !fullContent && (
                <button
                  onClick={handleFetchFull}
                  title="从原始网页提取全文"
                  style={{ ...textActionStyle, ...clusterGap, color: 'var(--text-tertiary)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-tertiary)')}
                >
                  <AlignLeft size={11} />
                  全文
                </button>
              )}
              {fullContent === 'loading' && (
                <span
                  style={{
                    ...textActionStyle,
                    ...clusterGap,
                    color: 'var(--text-tertiary)',
                    cursor: 'default',
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
                    ...textActionStyle,
                    ...clusterGap,
                    color: 'var(--accent)',
                    opacity: 0.8,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.8')}
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
                  style={{ ...textActionStyle, color: 'var(--accent)', opacity: 0.8 }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.8')}
                >
                  {/* Icon first, matching 全文 — both text actions read icon → label. */}
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M2 10L10 2M10 2H5M10 2v5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  原文
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
              marginBottom: 24,
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
              {currentEpisode?.id === article.id && isBuffering ? (
                <>
                  <Loader2
                    size={11}
                    strokeWidth={2}
                    style={{ animation: 'spin 0.8s linear infinite' }}
                  />{' '}
                  加载中
                </>
              ) : currentEpisode?.id === article.id && isPlaying ? (
                <>
                  <Pause size={11} strokeWidth={2} /> 暂停
                </>
              ) : currentEpisode?.id === article.id || canResume ? (
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
  // Feeds wrap images in their own <p>/<div>/<figure>. Removing the image leaves the
  // wrapper behind as a blank block that still claims its margins — a gap in the text
  // with nothing in it. Drop wrappers that hold nothing but whitespace once the media
  // is gone. Repeat so nested wrappers (<div><p><img></p></div>) collapse fully.
  for (let pass = 0; pass < 3; pass++) {
    const empties = doc.body.querySelectorAll<HTMLElement>('p, div, blockquote, li');
    let removed = 0;
    empties.forEach((el) => {
      if (!el.textContent?.trim() && !el.querySelector(MEDIA_SELECTOR + ', br, hr, input')) {
        el.remove();
        removed++;
      }
    });
    if (!removed) break;
  }
  return doc.body.innerHTML;
}

// Block-level tags that must end up on their own line in the copied plain text.
// Everything else (spans, links, emphasis) stays inline, as it reads on screen.
const BLOCK_SELECTOR =
  'p, div, section, article, h1, h2, h3, h4, h5, h6, li, blockquote, pre, tr, figure, figcaption, table';

// Flatten article HTML to plain text for the clipboard. Uses the DOM parser rather
// than a tag-stripping regex so entities decode and nested markup can't leak through;
// falls back to a naive strip where DOMParser is unavailable (non-browser).
export function htmlToPlainText(html: string): string {
  if (!html) return '';
  if (typeof DOMParser === 'undefined') {
    return normalizeText(html.replace(/<[^>]*>/g, ''));
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
  doc.querySelectorAll('br').forEach((el) => el.replaceWith('\n'));
  // A trailing newline per block is enough: normalizeText collapses the runs that
  // nested wrappers produce, so paragraphs end up separated by exactly one blank line.
  doc.querySelectorAll(BLOCK_SELECTOR).forEach((el) => el.append('\n\n'));
  // Cells would otherwise run together into one unreadable word.
  doc.querySelectorAll('td, th').forEach((el) => el.append('\t'));
  return normalizeText(doc.body.textContent || '');
}

// Trim per line, drop the blank-line runs that nested block wrappers leave behind,
// and normalize the non-breaking spaces feeds are full of.
function normalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, '').replace(/^[ \t]+/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// navigator.clipboard is unavailable in insecure contexts (plain-HTTP LAN access) and
// can reject when the document isn't focused, so keep the legacy path as a fallback.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length); // iOS ignores select() alone
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
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
      // Spacer paragraphs — <p><br></p>, <p>&nbsp;</p> — are how many feeds fake a blank
      // line. Against our own paragraph rhythm they render as an unexplained hole in the
      // column, so drop them and let .rss-article's margins do the spacing.
      .replace(/<p[^>]*>(?:\s|&nbsp;|&#160;|<br\s*\/?>)*<\/p>/gi, '')
  );
}

// 全文 / 原文 share one borderless text-action look: a bordered chip next to four bare
// 15px icon buttons read as a third button language crammed into the same row. Only the
// color/opacity differ per state — the geometry is identical.
const textActionStyle: React.CSSProperties = {
  fontSize: 12,
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  textDecoration: 'none',
  whiteSpace: 'nowrap',
  transition: 'color 0.15s, opacity 0.15s',
};

// Applied to whichever 全文 state renders — the first of the two text actions — to open
// the seam between the icon cluster and the text pair. The icon buttons carry 4px of
// their own padding, so their glyphs already sit 18px apart (4 + gap 10 + 4); the text
// actions have none, which puts them 10px apart. 10px extra here makes the seam 24px —
// wider than either cluster's internal rhythm, so the two groups read as two groups.
const clusterGap: React.CSSProperties = { marginLeft: 10 };

// Dates shrink last (flexShrink 1 against the byline's 100) and ellipsize rather than
// being chopped mid-glyph by the group's overflow: hidden.
const metaDateStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-tertiary)',
  whiteSpace: 'nowrap',
  minWidth: 0,
  flexShrink: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

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
      /* The meta rule above already sets the gap; a leading margin (or a heading's
         margin-top) would stack on top of it and open a blank band. */
      .rss-article > :first-child { margin-top: 0; }
      .rss-article > :last-child { margin-bottom: 0; }
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
