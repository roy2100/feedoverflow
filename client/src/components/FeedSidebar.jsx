import { useState } from 'react';
import { RefreshCw, Plus, X, Sun, Star, Circle } from 'lucide-react';

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
  feeds, selectedView, onSelectView, onDeleteFeed,
  unreadCount, starredCount, onRefresh, onOpenAddModal,
}) {
  const [hoveredFeed, setHoveredFeed] = useState(null);
  const groups = groupByCategory(feeds);

  return (
    <aside style={{
      width: 220, flexShrink: 0,
      background: 'var(--bg-panel)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      animation: 'slideIn 0.2s ease',
    }}>
      {/* Header */}
      <div style={{
        padding: '16px 14px 12px',
        borderBottom: '1px solid var(--border-light)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 12, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
          订阅源
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <IconBtn onClick={onRefresh} title="刷新"><RefreshCw size={13} /></IconBtn>
          <IconBtn onClick={onOpenAddModal} title="添加订阅"><Plus size={13} /></IconBtn>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        <SectionLabel>智能订阅</SectionLabel>

        <NavItem
          label="Today"
          icon={<Sun size={13} strokeWidth={2} />}
          iconColor="#F5A623"
          selected={selectedView.type === 'today'}
          onClick={() => onSelectView({ type: 'today' })}
        />
        <NavItem
          label="全部未读"
          icon={<Circle size={9} fill="var(--dot-unread)" strokeWidth={0} />}
          iconColor="var(--dot-unread)"
          count={unreadCount}
          selected={selectedView.type === 'all'}
          onClick={() => onSelectView({ type: 'all' })}
        />
        <NavItem
          label="Starred"
          icon={<Star size={13} strokeWidth={2} />}
          iconColor="#F5C518"
          count={starredCount}
          selected={selectedView.type === 'starred'}
          onClick={() => onSelectView({ type: 'starred' })}
        />

        {/* Feed groups */}
        {Object.entries(groups).map(([cat, catFeeds]) => (
          <div key={cat}>
            <SectionLabel style={{ marginTop: 8 }}>{cat}</SectionLabel>
            {catFeeds.map(feed => {
              const isSelected = selectedView.type === 'feed' && selectedView.feed?.id === feed.id;
              return (
                <div key={feed.id} style={{ position: 'relative' }}
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
                        position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                        color: 'var(--text-tertiary)', padding: 3, borderRadius: 3,
                        lineHeight: 1, transition: 'color 0.15s', zIndex: 1,
                        background: 'none', border: 'none', cursor: 'pointer',
                      }}
                      onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
                      onMouseLeave={e => e.currentTarget.style.color = 'var(--text-tertiary)'}
                      title="删除"
                    >
                      <X size={11} />
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

function IconBtn({ onClick, title, children }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{ color: 'var(--text-tertiary)', padding: 4, borderRadius: 4, transition: 'color 0.15s', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
      onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
      onMouseLeave={e => e.currentTarget.style.color = 'var(--text-tertiary)'}
    >
      {children}
    </button>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ padding: '2px 12px 6px', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
      {children}
    </div>
  );
}

function NavItem({ label, icon, iconColor, count, selected, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%', display: 'flex', alignItems: 'center',
        padding: '6px 12px', gap: 8,
        background: selected ? 'var(--bg-selected)' : 'transparent',
        color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontSize: 13, fontWeight: selected ? 500 : 400,
        textAlign: 'left', border: 'none', cursor: 'pointer',
        transition: 'background 0.1s, color 0.1s',
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
    >
      {icon && (
        <span style={{ color: iconColor, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          {icon}
        </span>
      )}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {count != null && count > 0 && (
        <span style={{ fontSize: 11, color: selected ? 'var(--accent)' : 'var(--text-tertiary)', fontWeight: 500, flexShrink: 0 }}>
          {count > 999 ? '999+' : count}
        </span>
      )}
    </button>
  );
}
