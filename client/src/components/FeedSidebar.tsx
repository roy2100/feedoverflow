import {
  RefreshCw,
  Plus,
  Sun,
  Star,
  List,
  Rss,
  Settings,
  SlidersHorizontal,
  PanelLeft,
  Search,
  Filter,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { faviconDomain } from '../faviconDomain';
import type { Feed, View } from '../types';

function FeedIcon({ url }: { url: string }) {
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

interface FeedSidebarProps {
  isMobile?: boolean;
  feeds: Feed[];
  selectedView: View;
  onSelectView: (view: View) => void;
  onRefresh: () => void;
  onToggleSidebar?: (() => void) | null;
  onOpenAddModal: () => void;
  onOpenManageModal?: (() => void) | null;
  onOpenSettings?: (() => void) | null;
  onSearch?: (query: string) => void;
  // Scoped-search toggle (desktop only). `scopeLabel` is non-null only when the base view is
  // scopable (Starred / a feed); the toggle button renders only then.
  scopedSearch?: boolean;
  scopeLabel?: string | null;
  onToggleSearchScope?: () => void;
}

export default function FeedSidebar({
  isMobile,
  feeds,
  selectedView,
  onSelectView,
  onRefresh,
  onToggleSidebar,
  onOpenAddModal,
  onOpenManageModal,
  onOpenSettings,
  onSearch,
  scopedSearch,
  scopeLabel,
  onToggleSearchScope,
}: FeedSidebarProps) {
  const [query, setQuery] = useState('');
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the box in sync when search is exited from elsewhere (e.g. a feed click).
  useEffect(() => {
    if (selectedView.type !== 'search') setQuery('');
  }, [selectedView.type]);

  const handleChange = (value: string) => {
    setQuery(value);
    if (isMobile) return; // mobile searches on submit to avoid sliding away mid-typing
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => onSearch?.(value.trim()), 250);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (debounce.current) clearTimeout(debounce.current);
    onSearch?.(query.trim());
  };

  const clearSearch = () => {
    setQuery('');
    if (debounce.current) clearTimeout(debounce.current);
    onSearch?.('');
  };

  // Scope toggle shows only on desktop and only when the base view is scopable (scopeLabel set).
  const scopeToggle = !isMobile && !!onToggleSearchScope && !!scopeLabel;

  // During a scoped search, keep the scoped base row (Starred / a feed) highlighted in the
  // sidebar — otherwise the selection would visually disappear while searching.
  const scoped = selectedView.type === 'search' ? selectedView.scope : undefined;
  const hlType = scoped ? scoped.kind : selectedView.type;
  const hlFeedId = scoped?.kind === 'feed' ? scoped.feedId : selectedView.feed?.id;

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {!isMobile && onToggleSidebar && (
            <IconBtn onClick={onToggleSidebar} title="收起侧边栏">
              <PanelLeft size={14} />
            </IconBtn>
          )}
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
        </div>
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

      {/* Search */}
      {onSearch && (
        <form
          onSubmit={handleSubmit}
          style={{
            padding: isMobile ? '12px 16px 4px' : '10px 12px 6px',
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <Search
            size={13}
            style={{
              position: 'absolute',
              left: isMobile ? 26 : 22,
              color: 'var(--text-tertiary)',
              pointerEvents: 'none',
            }}
          />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={scopedSearch && scopeLabel ? `在「${scopeLabel}」中搜索…` : '搜索文章…'}
            enterKeyHint="search"
            style={{
              width: '100%',
              padding: isMobile
                ? '9px 28px 9px 30px'
                : `6px ${20 + (scopeToggle ? 20 : 0) + (query ? 20 : 0)}px 6px 28px`,
              fontSize: isMobile ? 15 : 13,
              color: 'var(--text-primary)',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 7,
              outline: 'none',
            }}
          />
          <div
            style={{
              position: 'absolute',
              right: isMobile ? 24 : 18,
              display: 'flex',
              alignItems: 'center',
              gap: 2,
            }}
          >
            {query && (
              <button
                type="button"
                onClick={clearSearch}
                title="清除"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  color: 'var(--text-tertiary)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 2,
                }}
              >
                <X size={14} />
              </button>
            )}
            {scopeToggle && (
              <button
                type="button"
                onClick={() => {
                  onToggleSearchScope?.();
                  inputRef.current?.focus();
                }}
                title={scopedSearch ? `在「${scopeLabel}」中搜索` : '全局搜索'}
                aria-pressed={scopedSearch}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  color: scopedSearch ? 'var(--accent)' : 'var(--text-tertiary)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 2,
                }}
              >
                <Filter size={14} fill={scopedSearch ? 'var(--accent)' : 'none'} />
              </button>
            )}
          </div>
        </form>
      )}

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '8px 0 0' : '4px 0 0' }}>
        {!isMobile && <SectionLabel>智能订阅</SectionLabel>}
        {isMobile && <SectionLabel>智能订阅</SectionLabel>}

        <NavItem
          isMobile={isMobile}
          label="Today"
          icon={<Sun size={isMobile ? 16 : 13} strokeWidth={2} />}
          iconColor="#F5A623"
          selected={hlType === 'today'}
          onClick={() => onSelectView({ type: 'today' })}
        />
        <NavItem
          isMobile={isMobile}
          label="全部"
          icon={<List size={isMobile ? 16 : 13} strokeWidth={2} />}
          iconColor="var(--text-secondary)"
          selected={hlType === 'all'}
          onClick={() => onSelectView({ type: 'all' })}
        />
        <NavItem
          isMobile={isMobile}
          label="Starred"
          icon={<Star size={isMobile ? 16 : 13} strokeWidth={2} />}
          iconColor="#F5C518"
          selected={hlType === 'starred'}
          onClick={() => onSelectView({ type: 'starred' })}
        />

        {/* Feed list */}
        {feeds.length > 0 && <SectionLabel style={{ marginTop: 8 }}>订阅源</SectionLabel>}
        {feeds.map((feed) => {
          const isSelected = hlType === 'feed' && hlFeedId === feed.id;
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

interface IconBtnProps {
  onClick: () => void;
  title: string;
  isMobile?: boolean;
  children: React.ReactNode;
}

function IconBtn({ onClick, title, isMobile, children }: IconBtnProps) {
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

interface SectionLabelProps {
  children: React.ReactNode;
  style?: React.CSSProperties;
}

function SectionLabel({ children, style }: SectionLabelProps) {
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

interface NavItemProps {
  label: string;
  icon?: React.ReactNode;
  iconColor?: string;
  count?: number;
  selected: boolean;
  onClick: () => void;
  isMobile?: boolean;
}

function NavItem({ label, icon, iconColor, count, selected, onClick, isMobile }: NavItemProps) {
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
