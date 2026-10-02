import { ChevronLeft, Loader2, Mic, Rows3, Star } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { decodeEntities } from '../lib/decodeEntities';
import type { Article } from '../types';
import { formatDate } from './ArticleList';

// 刷 — the mobile list panel drawn as one full-screen card per article, swiped
// vertically. A presentation of the current list, not a view of its own: the
// articles, star state and reader are the ones the rows use.
//
// The gesture is native CSS scroll snap, deliberately not JS touch tracking (see
// docs/plan-drop-mobile-history.md for why this app keeps away from the latter);
// `scroll-snap-stop: always` makes one fling move exactly one card. Swiping never
// selects: selecting sets `selectedArticle`, and the always-mounted reader panel
// would fetch the full body of every card flicked past. A tap does.
// Rationale: docs/plan-swipe-deck.md.

interface ArticleDeckProps {
  articles: Article[];
  loading: boolean;
  viewTitle: string;
  emptyText?: string;
  // Whether panel 1 is the one on screen. Coming back to it re-pins the scroll to
  // the current card — see the effect below.
  active: boolean;
  hideFeedName?: boolean;
  onBack: () => void;
  onShowRows: () => void;
  onOpen: (article: Article) => void;
  onToggleStar: (article: Article) => void;
  onRefresh: () => void;
  onPlay: (article: Article) => void;
  currentEpisode: Article | null;
  isPlaying: boolean;
  isBuffering: boolean;
}

export default function ArticleDeck({
  articles,
  loading,
  viewTitle,
  emptyText,
  active,
  hideFeedName,
  onBack,
  onShowRows,
  onOpen,
  onToggleStar,
  onRefresh,
  onPlay,
  currentEpisode,
  isPlaying,
  isBuffering,
}: ArticleDeckProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0);
  indexRef.current = index;
  // The card the arrow keys last sent the deck to, until it gets there.
  const targetRef = useRef<number | null>(null);

  // Every card is exactly one scroller-height tall, so the current card is just
  // scrollTop / height — no IntersectionObserver needed.
  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el || el.clientHeight === 0) return;
    const i = Math.round(el.scrollTop / el.clientHeight);
    if (i !== indexRef.current) setIndex(i);
    // Arrived where the arrow keys sent it: later presses start from here again.
    if (i === targetRef.current) targetRef.current = null;
  };

  // A fresh (re)load starts at the top card, same as the rows.
  useLayoutEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
    targetRef.current = null;
    setIndex(0);
  }, [loading]);

  // Re-pin the scroll to the current card when the panel comes back on screen
  // and whenever the scroller changes height (the podcast bar appearing, the
  // viewport resizing). iOS can paint a scroller inside a transformed panel at a
  // stale offset (docs/issue-ios-pwa-list-scroll.md); in rows that clips one row,
  // in a snapped deck it would leave half a card on screen.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (active && el) el.scrollTop = indexRef.current * el.clientHeight;
  }, [active]);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      el.scrollTop = indexRef.current * el.clientHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = articles.length;

  // ↑/↓ page one card — for a Mac window narrowed to the mobile layout, where
  // there is no touch to swipe with. Only while the deck is the panel on screen,
  // so the arrows never move it from behind the reader. Steps chain off the last
  // requested card rather than the scroll position, so a second press during the
  // smooth scroll advances again instead of re-targeting the card it is leaving.
  useEffect(() => {
    if (!active || loading || total === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      if (t.isContentEditable) return;
      const el = scrollerRef.current;
      if (!el) return;
      e.preventDefault();
      const from = targetRef.current ?? indexRef.current;
      // `total` is the end card, the last place a step can land.
      const to = Math.max(0, Math.min(total, from + (e.key === 'ArrowDown' ? 1 : -1)));
      if (to === from) return;
      targetRef.current = to;
      el.scrollTo({ top: to * el.clientHeight, behavior: 'smooth' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, loading, total]);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--bg-reader)',
      }}
    >
      <div
        style={{
          padding: '0 16px',
          height: 52,
          flexShrink: 0,
          borderBottom: '1px solid var(--border-light)',
          background: 'var(--bg)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <button onClick={onBack} aria-label="返回" style={iconButton('var(--accent)')}>
          <ChevronLeft size={20} strokeWidth={2} />
        </button>
        <h2
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 16,
            fontWeight: 600,
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {viewTitle}
        </h2>
        {!loading && total > 0 && (
          <span
            style={{
              fontSize: 12,
              color: 'var(--text-tertiary)',
              fontVariantNumeric: 'tabular-nums',
              flexShrink: 0,
            }}
          >
            {Math.min(index + 1, total)} / {total}
          </span>
        )}
        <button
          onClick={onShowRows}
          aria-label="列表模式"
          style={iconButton('var(--text-tertiary)')}
        >
          <Rows3 size={18} strokeWidth={1.75} />
        </button>
      </div>

      {loading ? (
        <div style={centered}>
          <Loader2
            size={20}
            style={{ color: 'var(--text-tertiary)', animation: 'spin 0.8s linear infinite' }}
          />
        </div>
      ) : total === 0 ? (
        <div style={centered}>
          <span>{emptyText ?? '暂无文章'}</span>
          <button onClick={onRefresh} style={outlineButton}>
            重新加载
          </button>
        </div>
      ) : null}

      {/* Kept mounted through loading so its ref, and the scroll reset above,
          survive; hidden rather than unmounted. */}
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        data-testid="deck-scroller"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          scrollSnapType: 'y mandatory',
          overscrollBehavior: 'contain',
          display: loading || total === 0 ? 'none' : 'block',
        }}
      >
        {!loading &&
          articles.map((article) => (
            <DeckCard
              key={article.id}
              article={article}
              hideFeedName={hideFeedName}
              onOpen={onOpen}
              onToggleStar={onToggleStar}
              onPlay={onPlay}
              episodePlaying={currentEpisode?.id === article.id && isPlaying}
              episodeBuffering={currentEpisode?.id === article.id && isBuffering}
            />
          ))}
        {!loading && total > 0 && (
          <div style={{ ...cardFrame, ...centered, cursor: 'default' }}>
            <span>到底了 · 共 {total} 篇</span>
            <button onClick={onRefresh} style={outlineButton}>
              刷新
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface DeckCardProps {
  article: Article;
  hideFeedName?: boolean;
  onOpen: (article: Article) => void;
  onToggleStar: (article: Article) => void;
  onPlay: (article: Article) => void;
  episodePlaying: boolean;
  episodeBuffering: boolean;
}

function DeckCard({
  article,
  hideFeedName,
  onOpen,
  onToggleStar,
  onPlay,
  episodePlaying,
  episodeBuffering,
}: DeckCardProps) {
  const zh = article.titleZh?.trim();
  const summary = article.summary?.trim();
  const summaryRef = useRef<HTMLDivElement>(null);
  // The fade marks text that runs past the card. Measured rather than always on:
  // a summary that fits would otherwise have its last line faded out for nothing.
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = summaryRef.current;
    setOverflows(!!el && el.scrollHeight > el.clientHeight + 1);
  }, [summary]);

  return (
    <article
      role="button"
      onClick={() => onOpen(article)}
      data-id={article.id}
      style={{ ...cardFrame, padding: '28px 24px 16px' }}
    >
      {/* Short content sits centred; long content fills the card and the summary
          is clipped — a card never scrolls inside itself, it would fight the
          snap gesture. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            marginBottom: 12,
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {!hideFeedName && article.feedName && (
            <span
              style={{
                fontWeight: 600,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {article.feedName}
            </span>
          )}
          <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>
            {formatDate(article.pubDate)}
          </span>
        </div>

        <h3
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 24,
            fontWeight: 600,
            lineHeight: 1.35,
            letterSpacing: '-0.01em',
            color: 'var(--text-primary)',
            flexShrink: 0,
            ...clamp(5),
          }}
        >
          {decodeEntities(zh || article.title)}
        </h3>
        {/* Unlike the rows, the original stays: a card has the room, and this is
            where a headline gets judged before deciding to open it. */}
        {zh && (
          <div
            style={{
              marginTop: 6,
              fontSize: 13,
              lineHeight: 1.45,
              color: 'var(--text-tertiary)',
              flexShrink: 0,
              ...clamp(2),
            }}
          >
            {decodeEntities(article.title)}
          </div>
        )}

        {summary && (
          <div
            ref={summaryRef}
            style={{
              marginTop: 16,
              flex: '0 1 auto',
              minHeight: 0,
              overflow: 'hidden',
              fontSize: 16,
              lineHeight: 1.7,
              color: 'var(--text-secondary)',
              whiteSpace: 'pre-line',
              overflowWrap: 'anywhere',
              maskImage: overflows ? FADE : undefined,
              WebkitMaskImage: overflows ? FADE : undefined,
            }}
          >
            {summary}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          marginTop: 12,
          flexShrink: 0,
          fontSize: 13,
        }}
      >
        {article.audioUrl && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPlay(article);
            }}
            style={{
              ...iconButton(
                episodePlaying || episodeBuffering ? 'var(--accent)' : 'var(--accent-light)',
              ),
              gap: 4,
              fontSize: 13,
            }}
          >
            {episodeBuffering ? (
              <Loader2 size={15} style={{ animation: 'spin 0.8s linear infinite' }} />
            ) : (
              <Mic size={15} strokeWidth={episodePlaying ? 2.5 : 2} />
            )}
            {episodeBuffering
              ? '加载中'
              : episodePlaying
                ? '播放中'
                : article.audioDuration || '播放'}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar(article);
          }}
          aria-label={article.isStarred ? '取消收藏' : '收藏'}
          style={iconButton(article.isStarred ? '#F5C518' : 'var(--text-tertiary)')}
        >
          <Star size={20} fill={article.isStarred ? '#F5C518' : 'none'} strokeWidth={1.5} />
        </button>
        {article.link && (
          <a
            href={article.link}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{
              ...iconButton('var(--accent)'),
              fontSize: 13,
              textDecoration: 'none',
            }}
          >
            原文
          </a>
        )}
      </div>
    </article>
  );
}

const FADE = 'linear-gradient(to bottom, #000 calc(100% - 3.4em), transparent)';

const cardFrame: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  scrollSnapAlign: 'start',
  scrollSnapStop: 'always',
  borderBottom: '1px solid var(--border-light)',
  cursor: 'pointer',
  overflow: 'hidden',
};

const centered: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
  color: 'var(--text-tertiary)',
  fontSize: 13,
};

const outlineButton: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--accent)',
  padding: '4px 10px',
  border: '1px solid var(--accent)',
  borderRadius: 5,
  cursor: 'pointer',
  background: 'none',
};

function iconButton(color: string): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 8,
    flexShrink: 0,
    color,
  };
}

function clamp(lines: number): React.CSSProperties {
  return {
    display: '-webkit-box',
    WebkitLineClamp: lines,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  };
}
