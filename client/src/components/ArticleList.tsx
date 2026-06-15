import { ChevronLeft, Mic, PanelLeft } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';

import type { Article } from '../types';

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400)
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
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
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
  sidebarCollapsed,
  onToggleSidebar,
}: ArticleListProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedArticle || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-id="${selectedArticle.id}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedArticle?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      style={{
        width: isMobile ? '100%' : 300,
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
      </div>

      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
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
              onClick={() => onSelectArticle(article)}
              onPlay={onPlay}
              episodePlaying={currentEpisode?.id === article.id && isPlaying}
              isMobile={isMobile}
              style={{ animationDelay: `${Math.min(i * 20, 300)}ms` }}
              data-id={article.id}
            />
          ))
        )}
      </div>
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
  isMobile?: boolean;
  style?: React.CSSProperties;
  'data-id'?: string;
}

function ArticleItem({
  article,
  selected,
  onClick,
  onPlay,
  episodePlaying,
  isMobile,
  style,
  'data-id': dataId,
}: ArticleItemProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      role="button"
      data-id={dataId}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        padding: isMobile ? '14px 16px' : '12px 16px',
        background: selected ? 'var(--bg-selected)' : hovered ? 'var(--bg-hover)' : 'transparent',
        borderBottom: '1px solid var(--border-light)',
        cursor: 'pointer',
        transition: 'background 0.1s',
        animation: 'fadeIn 0.25s ease both',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
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
            <span
              style={{
                fontSize: 11,
                color: 'var(--text-tertiary)',
                flexShrink: 0,
                marginLeft: 'auto',
              }}
            >
              {formatDate(article.pubDate)}
            </span>
          </div>
          <div
            style={{
              fontSize: isMobile ? 14 : 13,
              fontWeight: 400,
              color: 'var(--text-primary)',
              lineHeight: 1.45,
              marginBottom: article.audioUrl ? 4 : 0,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {article.title}
          </div>
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
                color: episodePlaying ? 'var(--accent)' : 'var(--accent-light)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              <Mic size={10} strokeWidth={episodePlaying ? 2.5 : 2} />
              {episodePlaying ? '播放中' : article.audioDuration || '播客'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
