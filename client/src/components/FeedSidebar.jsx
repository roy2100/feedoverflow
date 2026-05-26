import { useState } from 'react';

const ICONS = {
  all: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M5 8h6M8 5v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  feed: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M3 3.5A.5.5 0 013.5 3h9a.5.5 0 010 1h-9A.5.5 0 013 3.5zM3 8a.5.5 0 01.5-.5h9a.5.5 0 010 1h-9A.5.5 0 013 8zM3.5 12a.5.5 0 000 1h9a.5.5 0 000-1h-9z" fill="currentColor"/>
    </svg>
  ),
  add: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  refresh: (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M14 8A6 6 0 112 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M14 4v4h-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  delete: (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
};

function groupByCategory(feeds) {
  const groups = {};
  for (const f of feeds) {
    const cat = f.category || '未分类';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(f);
  }
  return groups;
}

export default function FeedSidebar({
  feeds, selectedView, onSelectView, onDeleteFeed, totalUnread, onRefresh, onOpenAddModal
}) {
  const [hoveredFeed, setHoveredFeed] = useState(null);

  const groups = groupByCategory(feeds);

  const isAllSelected = selectedView.type === 'all';

  return (
    <aside style={{
      width: 220,
      flexShrink: 0,
      background: 'var(--bg-panel)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      animation: 'slideIn 0.2s ease',
    }}>
      {/* Header */}
      <div style={{
        padding: '16px 14px 12px',
        borderBottom: '1px solid var(--border-light)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <span style={{
          fontSize: 12,
          fontWeight: 500,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
        }}>订阅源</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={onRefresh}
            style={{ color: 'var(--text-tertiary)', padding: 4, borderRadius: 4, transition: 'color 0.15s' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-tertiary)'}
            title="刷新"
          >
            {ICONS.refresh}
          </button>
          <button
            onClick={onOpenAddModal}
            style={{ color: 'var(--text-tertiary)', padding: 4, borderRadius: 4, transition: 'color 0.15s' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-tertiary)'}
            title="添加订阅"
          >
            {ICONS.add}
          </button>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {/* Smart Feeds */}
        <div style={{ padding: '2px 12px 6px', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
          智能订阅
        </div>
        <NavItem
          label="全部未读"
          count={totalUnread}
          selected={isAllSelected}
          onClick={() => onSelectView({ type: 'all' })}
          icon="●"
        />

        {/* Feed groups */}
        {Object.entries(groups).map(([cat, catFeeds]) => (
          <div key={cat}>
            <div style={{
              padding: '10px 12px 4px',
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
            }}>
              {cat}
            </div>
            {catFeeds.map(feed => {
              const isSelected = selectedView.type === 'feed' && selectedView.feed?.id === feed.id;
              return (
                <div
                  key={feed.id}
                  style={{ position: 'relative' }}
                  onMouseEnter={() => setHoveredFeed(feed.id)}
                  onMouseLeave={() => setHoveredFeed(null)}
                >
                  <NavItem
                    label={feed.name}
                    selected={isSelected}
                    onClick={() => onSelectView({ type: 'feed', feed })}
                  />
                  {hoveredFeed === feed.id && (
                    <button
                      onClick={() => onDeleteFeed(feed.id)}
                      style={{
                        position: 'absolute',
                        right: 10,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        color: 'var(--text-tertiary)',
                        padding: 3,
                        borderRadius: 3,
                        lineHeight: 1,
                        transition: 'color 0.15s',
                        zIndex: 1,
                      }}
                      onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
                      onMouseLeave={e => e.currentTarget.style.color = 'var(--text-tertiary)'}
                      title="删除"
                    >
                      {ICONS.delete}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}

function NavItem({ label, count, selected, onClick, icon }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        padding: '6px 12px',
        gap: 8,
        background: selected ? 'var(--bg-selected)' : 'transparent',
        color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontSize: 13,
        fontWeight: selected ? 500 : 400,
        textAlign: 'left',
        borderRadius: 0,
        transition: 'background 0.1s, color 0.1s',
        cursor: 'pointer',
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
    >
      {icon && (
        <span style={{ fontSize: 7, color: 'var(--dot-unread)', lineHeight: 1 }}>{icon}</span>
      )}
      <span style={{
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>{label}</span>
      {count != null && count > 0 && (
        <span style={{
          fontSize: 11,
          color: selected ? 'var(--accent)' : 'var(--text-tertiary)',
          fontWeight: 500,
          minWidth: 20,
          textAlign: 'right',
        }}>
          {count > 999 ? '999+' : count}
        </span>
      )}
    </button>
  );
}
