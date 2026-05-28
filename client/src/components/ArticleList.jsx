import { useState } from 'react';
import { ChevronLeft, Mic } from 'lucide-react';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function ArticleList({
  isMobile, onBack,
  articles, selectedArticle, onSelectArticle,
  loading, viewTitle, onRefresh,
  onPlay, currentEpisode, isPlaying,
}) {
  return (
    <div style={{
      width: isMobile ? '100%' : 300,
      flexShrink: 0,
      background: 'var(--bg)',
      borderRight: isMobile ? 'none' : '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      height: isMobile ? '100%' : undefined,
    }}>
      <div style={{
        padding: isMobile ? '0 16px' : '14px 16px 12px',
        height: isMobile ? 52 : undefined,
        borderBottom: '1px solid var(--border-light)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
      }}>
        {isMobile && (
          <button
            onClick={onBack}
            style={{
              display: 'flex', alignItems: 'center', gap: 2,
              color: 'var(--accent)', background: 'none', border: 'none',
              cursor: 'pointer', padding: '6px 8px 6px 0', fontSize: 15,
              flexShrink: 0,
            }}
          >
            <ChevronLeft size={20} strokeWidth={2} />
          </button>
        )}
        <h2 style={{
          fontSize: isMobile ? 16 : 14,
          fontWeight: 600,
          color: 'var(--text-primary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          flex: 1,
        }}>
          {viewTitle}
        </h2>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)', flexShrink: 0, marginLeft: 8 }}>
          {!loading && `${articles.length} 篇`}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--text-tertiary)', fontSize: 13 }}>
            <span style={{ width: 14, height: 14, border: '1.5px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', display: 'inline-block' }} />
            加载中
          </div>
        ) : articles.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)', fontSize: 13, flexDirection: 'column', gap: 12 }}>
            <span>暂无文章</span>
            <button onClick={onRefresh} style={{ fontSize: 12, color: 'var(--accent)', padding: '4px 10px', border: '1px solid var(--accent)', borderRadius: 5, cursor: 'pointer', background: 'none' }}>
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
            />
          ))
        )}
      </div>
    </div>
  );
}

function ArticleItem({ article, selected, onClick, onPlay, episodePlaying, isMobile, style }) {
  const [hovered, setHovered] = useState(false);
  const summary = (article.summary || '').replace(/<[^>]+>/g, '').slice(0, 80);

  return (
    <div
      role="button"
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
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        {/* Unread dot */}
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: article.isRead ? 'transparent' : 'var(--dot-unread)',
          flexShrink: 0, marginTop: isMobile ? 7 : 5, transition: 'background 0.2s',
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {article.feedName && (
            <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--accent-light)', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {article.feedName}
            </div>
          )}
          <div style={{ fontSize: isMobile ? 14 : 13, fontWeight: article.isRead ? 400 : 500, color: article.isRead ? 'var(--text-secondary)' : 'var(--text-primary)', lineHeight: 1.45, marginBottom: 4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {article.title}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {article.audioUrl ? (
              <button
                onClick={(e) => { e.stopPropagation(); onPlay?.(article); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 3,
                  fontSize: 11, fontWeight: 500,
                  color: episodePlaying ? 'var(--accent)' : 'var(--accent-light)',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                }}
              >
                <Mic size={10} strokeWidth={episodePlaying ? 2.5 : 2} />
                {episodePlaying ? '播放中' : (article.audioDuration || '播客')}
              </button>
            ) : (
              <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {summary}
              </span>
            )}
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0, marginLeft: 'auto' }}>
              {formatDate(article.pubDate)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
