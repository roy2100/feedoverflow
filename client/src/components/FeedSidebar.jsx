import { useState } from 'react';
import { RefreshCw, Plus, Sun, Star, Circle, Rss, Settings } from 'lucide-react';

function FeedIcon({ url }) {
  const [failed, setFailed] = useState(false);
  let domain = '';
  try {
    domain = new URL(url).hostname;
  } catch {
    // ignore
  }
  if (failed || !domain) {
    return <Rss size={13} style={{ color: 'var(--text-tertiary)' }} />;
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`}
      alt=""
      width={14}
      height={14}
      style={{ borderRadius: 3, objectFit: 'contain', flexShrink: 0 }}
      onError={() => setFailed(true)}
    />
  );
}

export default function FeedSidebar({
  feeds, selectedView, onSelectView,
  unreadCount, starredCount, onRefresh, onOpenAddModal, onOpenManageModal,
}) {
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
          <IconBtn onClick={onOpenManageModal} title="管理订阅源"><Settings size={13} /></IconBtn>
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

        {/* Feed list */}
        {feeds.length > 0 && <SectionLabel style={{ marginTop: 8 }}>订阅源</SectionLabel>}
        {feeds.map(feed => {
          const isSelected = selectedView.type === 'feed' && selectedView.feed?.id === feed.id;
          return (
            <NavItem
              key={feed.id}
              label={feed.name}
              icon={<FeedIcon url={feed.url} />}
              selected={isSelected}
              onClick={() => onSelectView({ type: 'feed', feed })}
            />
          );
        })}
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
