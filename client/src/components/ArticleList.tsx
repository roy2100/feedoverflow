import { ChevronLeft, Mic, PanelLeft, Loader2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { decodeEntities } from '../lib/decodeEntities';
import type { Article, ListMode } from '../types';

// pubDate is canonical ISO-8601 from the server (it owns date parsing), so native
// `new Date()` is reliable here.
function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  const isSameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isSameDay)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

interface ArticleListProps {
  isMobile?: boolean;
  onBack?: () => void;
  articles: Article[];
  selectedArticle: Article | null;
  onSelectArticle: (article: Article) => void;
  loading: boolean;
  viewTitle?: string;
  onRefresh: () => void;
  onPlay: (article: Article) => void;
  currentEpisode: Article | null;
  isPlaying: boolean;
  isBuffering: boolean;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  hideFeedName?: boolean;
  // Latest/digest ordering toggle — shown only for the merged 全部/今日 lists.
  showModeToggle?: boolean;
  listMode?: ListMode;
  onSetListMode?: (mode: ListMode) => void;
}

export default function ArticleList({
  isMobile,
  onBack,
  articles,
  selectedArticle,
  onSelectArticle,
  loading,
  viewTitle,
  onRefresh,
  onPlay,
  currentEpisode,
  isPlaying,
  isBuffering,
  sidebarCollapsed,
  onToggleSidebar,
  hideFeedName,
  showModeToggle,
  listMode,
  onSetListMode,
}: ArticleListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // Mobile: pin the list to its first row on every fresh (re)load — on BOTH the
  // `loading` rising edge (skeleton appears) and falling edge (real rows arrive).
  // `loading` flips only on a genuine (re)load — entering a view from the sidebar,
  // searching, or pull-to-refresh — and never on optimistic mutations like starring
  // (which replace the `articles` array but leave `loading` untouched) or on returning
  // from the reader (no reload, so scroll is preserved). The rising-edge reset matters
  // because the skeleton would otherwise paint at the stale upward offset iOS Safari
  // leaves behind when the pane slides back in via the ancestor transform; the
  // falling-edge reset re-pins once real rows replace the skeleton. We set scrollTop
  // directly rather than scrollIntoView: the latter walks up and scrolls every ancestor
  // (and the root) to reveal the row, which on first load would drag the off-screen
  // `translateX(100%)` list pane into the viewport.
  useLayoutEffect(() => {
    if (!isMobile || !listRef.current) return;
    listRef.current.scrollTop = 0;
  }, [isMobile, loading]);
  // Set when selection originates from a mouse click — suppresses the auto-recenter so a
  // click only highlights the row in place. Keyboard navigation leaves it false.
  const clickSelectRef = useRef(false);

  useEffect(() => {
    if (isMobile) return; // PC-only behavior — mobile is a single pane, no list paging
    if (clickSelectRef.current) {
      clickSelectRef.current = false;
      return;
    }
    if (!selectedArticle || !listRef.current) return;
    const container = listRef.current;
    const el = container.querySelector<HTMLElement>(`[data-id="${selectedArticle.id}"]`);
    if (!el) return;
    // Keep a margin band at top/bottom. Once the selected row crosses into it, recenter
    // the row in one scroll so upcoming articles stay visible in either direction.
    const margin = Math.min(el.offsetHeight * 1.5, container.clientHeight / 3);
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    if (top < viewTop + margin || bottom > viewBottom - margin) {
      const center = top + el.offsetHeight / 2 - container.clientHeight / 2;
      container.scrollTo({ top: Math.max(0, center) });
    }
  }, [selectedArticle?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      style={{
        width: isMobile ? '100%' : 380,
        flexShrink: 0,
        background: 'var(--bg)',
        borderRight: isMobile ? 'none' : '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        height: isMobile ? '100%' : undefined,
      }}
    >
      <div
        style={{
          padding: isMobile ? '0 16px' : '14px 16px 12px',
          height: isMobile ? 52 : undefined,
          borderBottom: '1px solid var(--border-light)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        {isMobile && (
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
          </button>
        )}
        {!isMobile && sidebarCollapsed && onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            title="展开侧边栏"
            style={{
              color: 'var(--text-tertiary)',
              padding: 4,
              marginRight: 8,
              borderRadius: 6,
              transition: 'color 0.15s',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-tertiary)')}
          >
            <PanelLeft size={14} />
          </button>
        )}
        <h2
          style={{
            fontSize: isMobile ? 16 : 14,
            fontWeight: 600,
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {viewTitle}
        </h2>
        {showModeToggle && onSetListMode && (
          <ModeToggle mode={listMode ?? 'latest'} onSet={onSetListMode} />
        )}
      </div>

      {/*
        No `-webkit-overflow-scrolling: touch`: it promotes this list into a separate
        composited momentum-scroll layer. When the mobile pane slides off-screen via the
        ancestor's `transform: translateX(...)` and back, iOS Safari fails to re-sync that
        layer with the real scrollTop, painting the content at a stale upward offset.
        Momentum scrolling is the default on iOS 13+, so the property is unneeded.
      */}
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          Array.from({ length: 7 }, (_, i) => <SkeletonItem key={i} isMobile={isMobile} />)
        ) : articles.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--text-tertiary)',
              fontSize: 13,
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <span>暂无文章</span>
            <button
              onClick={onRefresh}
              style={{
                fontSize: 12,
                color: 'var(--accent)',
                padding: '4px 10px',
                border: '1px solid var(--accent)',
                borderRadius: 5,
                cursor: 'pointer',
                background: 'none',
              }}
            >
              重新加载
            </button>
          </div>
        ) : (
          articles.map((article, i) => (
            <ArticleItem
              key={article.id}
              article={article}
              selected={selectedArticle?.id === article.id}
              onClick={() => {
                clickSelectRef.current = true;
                onSelectArticle(article);
              }}
              onPlay={onPlay}
              episodePlaying={currentEpisode?.id === article.id && isPlaying}
              episodeBuffering={currentEpisode?.id === article.id && isBuffering}
              isMobile={isMobile}
              hideFeedName={hideFeedName}
              style={{ animationDelay: `${Math.min(i * 20, 300)}ms` }}
              data-id={article.id}
            />
          ))
        )}
      </div>
    </div>
  );
}

// Segmented control: 最新 (strict global newest) vs 摘要 (per-feed quota, every feed represented).
function ModeToggle({ mode, onSet }: { mode: ListMode; onSet: (mode: ListMode) => void }) {
  const options: { value: ListMode; label: string; title: string }[] = [
    { value: 'latest', label: '最新', title: '严格按时间显示最新文章' },
    { value: 'digest', label: '摘要', title: '每个订阅源公平展示其最新文章' },
  ];
  return (
    <div
      style={{
        display: 'flex',
        flexShrink: 0,
        marginLeft: 8,
        gap: 2,
        padding: 2,
        borderRadius: 7,
        background: 'var(--bg-selected)',
      }}
    >
      {options.map((o) => {
        const active = mode === o.value;
        return (
          <button
            key={o.value}
            onClick={() => onSet(o.value)}
            title={o.title}
            style={{
              fontSize: 11,
              fontWeight: 600,
              lineHeight: 1.4,
              padding: '2px 9px',
              borderRadius: 5,
              border: 'none',
              cursor: 'pointer',
              transition: 'color 0.15s, background 0.15s',
              background: active ? 'var(--bg)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text-tertiary)',
              boxShadow: active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function SkeletonItem({ isMobile }: { isMobile?: boolean }) {
  const p = isMobile ? '14px 16px' : '12px 16px';
  return (
    <div style={{ padding: p, borderBottom: '1px solid var(--border-light)' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div className="skeleton-bar" style={{ height: 9, width: '38%' }} />
        <div className="skeleton-bar" style={{ height: 12, width: '92%' }} />
        <div className="skeleton-bar" style={{ height: 12, width: '68%' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
          <div className="skeleton-bar" style={{ height: 9, width: '55%' }} />
          <div className="skeleton-bar" style={{ height: 9, width: '15%' }} />
        </div>
      </div>
    </div>
  );
}

interface ArticleItemProps {
  article: Article;
  selected: boolean;
  onClick: () => void;
  onPlay?: (article: Article) => void;
  episodePlaying: boolean;
  episodeBuffering: boolean;
  isMobile?: boolean;
  hideFeedName?: boolean;
  style?: React.CSSProperties;
  'data-id'?: string;
}

function ArticleItem({
  article,
  selected,
  onClick,
  onPlay,
  episodePlaying,
  episodeBuffering,
  isMobile,
  hideFeedName,
  style,
  'data-id': dataId,
}: ArticleItemProps) {
  const titleStyle: React.CSSProperties = {
    fontSize: isMobile ? 14 : 13,
    fontWeight: 400,
    color: 'var(--text-primary)',
    lineHeight: 1.45,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  };
  const timeStyle: React.CSSProperties = {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    flexShrink: 0,
  };

  return (
    <div
      role="button"
      data-id={dataId}
      onClick={onClick}
      style={{
        position: 'relative',
        padding: isMobile ? '14px 16px' : '12px 16px',
        background: selected ? 'var(--bg-selected)' : 'transparent',
        borderBottom: '1px solid var(--border-light)',
        cursor: 'default',
        transition: 'background 0.1s',
        animation: 'fadeIn 0.25s ease both',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {hideFeedName ? (
            /* No feed name: title and time share one row to avoid an empty meta line */
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                marginBottom: article.audioUrl ? 4 : 0,
              }}
            >
              <div style={{ ...titleStyle, flex: 1, minWidth: 0 }}>
                {decodeEntities(article.title)}
              </div>
              <span style={{ ...timeStyle, marginTop: 1 }}>{formatDate(article.pubDate)}</span>
            </div>
          ) : (
            <>
              {/* Feed name + time on one row */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3 }}>
                {article.feedName && (
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 600,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: 'var(--accent-light)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                    }}
                  >
                    {article.feedName}
                  </span>
                )}
                <span style={{ ...timeStyle, marginLeft: 'auto' }}>
                  {formatDate(article.pubDate)}
                </span>
              </div>
              <div style={{ ...titleStyle, marginBottom: article.audioUrl ? 4 : 0 }}>
                {decodeEntities(article.title)}
              </div>
            </>
          )}
          {article.audioUrl && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onPlay?.(article);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 3,
                fontSize: 11,
                fontWeight: 500,
                color: episodePlaying || episodeBuffering ? 'var(--accent)' : 'var(--accent-light)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {episodeBuffering ? (
                <Loader2
                  size={10}
                  strokeWidth={2}
                  style={{ animation: 'spin 0.8s linear infinite' }}
                />
              ) : (
                <Mic size={10} strokeWidth={episodePlaying ? 2.5 : 2} />
              )}
              {episodeBuffering
                ? '加载中'
                : episodePlaying
                  ? '播放中'
                  : article.audioDuration || '播客'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
