import { RefreshCw, Plus, Sun, Star, List, Rss, Settings, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';

import { faviconDomain } from '../faviconDomain.js';

function FeedIcon({ url }) {
  const [failed, setFailed] = useState(false);
  const domain = faviconDomain(url);
  if (failed || !domain) {
    return <Rss size={13} style={{ color: 'var(--text-tertiary)' }} />;
  }
  return (
    <img
      src={`/api/favicon?domain=${domain}`}
      alt=""
      width={14}
      height={14}
      style={{ borderRadius: 3, objectFit: 'contain', flexShrink: 0 }}
      onError={() => setFailed(true)}
    />
  );
}

export default function FeedSidebar({
  isMobile,
  feeds,
  selectedView,
  onSelectView,
  onRefresh,
  onOpenAddModal,
  onOpenManageModal,
  onOpenSettings,
}) {
  return (
    <aside
      style={{
        width: isMobile ? '100%' : 220,
        flexShrink: 0,
        background: 'var(--bg-panel)',
        borderRight: isMobile ? 'none' : '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        height: isMobile ? '100%' : undefined,
        animation: 'slideIn 0.2s ease',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: isMobile ? '16px 16px 14px' : '16px 14px 12px',
          borderBottom: '1px solid var(--border-light)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span
          style={{
            fontSize: isMobile ? 15 : 12,
            fontWeight: 600,
            letterSpacing: isMobile ? 0 : '0.08em',
            textTransform: isMobile ? 'none' : 'uppercase',
            color: isMobile ? 'var(--text-primary)' : 'var(--text-tertiary)',
          }}
        >
          订阅
        </span>
        <div style={{ display: 'flex', gap: isMobile ? 8 : 4 }}>
          <IconBtn onClick={onRefresh} title="刷新" isMobile={isMobile}>
            <RefreshCw size={isMobile ? 17 : 13} />
          </IconBtn>
          {!isMobile && onOpenManageModal && (
            <IconBtn onClick={onOpenManageModal} title="管理订阅源">
              <Settings size={13} />
            </IconBtn>
          )}
          <IconBtn onClick={onOpenAddModal} title="添加订阅" isMobile={isMobile}>
            <Plus size={isMobile ? 17 : 13} />
          </IconBtn>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '12px 0 0' : '8px 0 0' }}>
        {!isMobile && <SectionLabel>智能订阅</SectionLabel>}
        {isMobile && <SectionLabel>智能订阅</SectionLabel>}

        <NavItem
          isMobile={isMobile}
          label="Today"
          icon={<Sun size={isMobile ? 16 : 13} strokeWidth={2} />}
          iconColor="#F5A623"
          selected={selectedView.type === 'today'}
          onClick={() => onSelectView({ type: 'today' })}
        />
        <NavItem
          isMobile={isMobile}
          label="全部"
          icon={<List size={isMobile ? 16 : 13} strokeWidth={2} />}
          iconColor="var(--text-secondary)"
          selected={selectedView.type === 'all'}
          onClick={() => onSelectView({ type: 'all' })}
        />
        <NavItem
          isMobile={isMobile}
          label="Starred"
          icon={<Star size={isMobile ? 16 : 13} strokeWidth={2} />}
          iconColor="#F5C518"
          selected={selectedView.type === 'starred'}
          onClick={() => onSelectView({ type: 'starred' })}
        />

        {/* Feed list */}
        {feeds.length > 0 && <SectionLabel style={{ marginTop: 8 }}>订阅源</SectionLabel>}
        {feeds.map((feed) => {
          const isSelected = selectedView.type === 'feed' && selectedView.feed?.id === feed.id;
          return (
            <NavItem
              key={feed.id}
              isMobile={isMobile}
              label={feed.name}
              icon={<FeedIcon url={feed.url} />}
              selected={isSelected}
              onClick={() => onSelectView({ type: 'feed', feed })}
            />
          );
        })}
      </nav>

      {/* Footer — desktop only */}
      {!isMobile && (
        <div
          style={{
            borderTop: '1px solid var(--border-light)',
            padding: '8px 12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span
            style={{
              fontSize: 10,
              color: 'var(--text-tertiary)',
              letterSpacing: '0.04em',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {__BUILD_DATE__}
          </span>
          {onOpenSettings && (
            <IconBtn onClick={onOpenSettings} title="设置">
              <SlidersHorizontal size={13} />
            </IconBtn>
          )}
        </div>
      )}
    </aside>
  );
}

function IconBtn({ onClick, title, isMobile, children }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        color: 'var(--text-tertiary)',
        padding: isMobile ? 6 : 4,
        borderRadius: 6,
        transition: 'color 0.15s',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent)')}
      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-tertiary)')}
    >
      {children}
    </button>
  );
}

function SectionLabel({ children, style }) {
  return (
    <div
      style={{
        padding: '2px 12px 6px',
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function NavItem({ label, icon, iconColor, count, selected, onClick, isMobile }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        padding: isMobile ? '11px 16px' : '6px 12px',
        gap: isMobile ? 12 : 8,
        background: selected ? 'var(--bg-selected)' : 'transparent',
        color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontSize: isMobile ? 15 : 13,
        fontWeight: selected ? 500 : 400,
        textAlign: 'left',
        border: 'none',
        cursor: 'pointer',
        transition: 'background 0.1s, color 0.1s',
        borderBottom: isMobile ? '1px solid var(--border-light)' : 'none',
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = 'var(--bg-hover)';
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = 'transparent';
      }}
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
        <span
          style={{
            fontSize: 12,
            color: selected ? 'var(--accent)' : 'var(--text-tertiary)',
            fontWeight: 500,
            flexShrink: 0,
          }}
        >
          {count > 999 ? '999+' : count}
        </span>
      )}
    </button>
  );
}
