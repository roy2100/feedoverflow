function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) {
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
  }
  const mo = d.getMonth() + 1;
  const day = d.getDate();
  return `${mo}/${day}`;
}

export default function ArticleList({
  articles, selectedArticle, onSelectArticle, loading, readSet, viewTitle, onRefresh
}) {
  return (
    <div style={{
      width: 300,
      flexShrink: 0,
      background: 'var(--bg)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 16px 12px',
        borderBottom: '1px solid var(--border-light)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <h2 style={{
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {viewTitle}
        </h2>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)', flexShrink: 0, marginLeft: 8 }}>
          {loading ? '' : `${articles.length} 篇`}
        </span>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: 8,
            color: 'var(--text-tertiary)',
            fontSize: 13,
          }}>
            <span style={{
              width: 14,
              height: 14,
              border: '1.5px solid var(--border)',
              borderTopColor: 'var(--accent)',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
              display: 'inline-block',
            }} />
            加载中
          </div>
        ) : articles.length === 0 ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--text-tertiary)',
            fontSize: 13,
            flexDirection: 'column',
            gap: 12,
          }}>
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
              }}
            >
              重新加载
            </button>
          </div>
        ) : (
          articles.map((article, i) => {
            const isSelected = selectedArticle?.id === article.id;
            const isRead = readSet.has(article.id);
            return (
              <ArticleItem
                key={article.id}
                article={article}
                selected={isSelected}
                read={isRead}
                onClick={() => onSelectArticle(article)}
                style={{ animationDelay: `${Math.min(i * 20, 300)}ms` }}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

function ArticleItem({ article, selected, read, onClick, style }) {
  const summary = article.summary
    ? article.summary.replace(/<[^>]+>/g, '').slice(0, 80)
    : '';

  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        padding: '12px 16px',
        textAlign: 'left',
        background: selected ? 'var(--bg-selected)' : 'transparent',
        borderBottom: '1px solid var(--border-light)',
        transition: 'background 0.1s',
        cursor: 'pointer',
        animation: 'fadeIn 0.25s ease both',
        ...style,
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        {/* Unread dot */}
        <span style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: read ? 'transparent' : 'var(--dot-unread)',
          flexShrink: 0,
          marginTop: 5,
          transition: 'background 0.2s',
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Feed name for "All" view */}
          {article.feedName && (
            <div style={{
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--accent-light)',
              marginBottom: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {article.feedName}
            </div>
          )}
          {/* Title */}
          <div style={{
            fontSize: 13,
            fontWeight: read ? 400 : 500,
            color: read ? 'var(--text-secondary)' : 'var(--text-primary)',
            lineHeight: 1.45,
            marginBottom: 4,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>
            {article.title}
          </div>
          {/* Summary + time */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{
              fontSize: 11.5,
              color: 'var(--text-tertiary)',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {summary}
            </span>
            <span style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              flexShrink: 0,
            }}>
              {formatDate(article.pubDate)}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}
