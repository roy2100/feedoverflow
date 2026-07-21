import { X, Check, Trash2, Pencil, Rss, Copy, CopyCheck, Bell, BellOff } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { faviconDomain } from '../faviconDomain';
import { useIsMobile } from '../hooks/useIsMobile';
import { ensureSubscribed, unsubscribeDevice } from '../lib/push';
import type { Feed } from '../types';

function fallbackCopy(text: string, onDone: () => void) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    onDone();
  } catch {}
  document.body.removeChild(ta);
}

function FeedIcon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const domain = faviconDomain(url);
  if (failed || !domain) return <Rss size={13} style={{ color: 'var(--text-tertiary)' }} />;
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

interface ManageFeedsModalProps {
  feeds: Feed[];
  onClose: () => void;
  onDelete: (feedId: string) => Promise<void>;
  onUpdate: (feedId: string, patch: { name?: string; push_enabled?: boolean }) => Promise<void>;
}

export default function ManageFeedsModal({
  feeds,
  onClose,
  onDelete,
  onUpdate,
}: ManageFeedsModalProps) {
  // Only one row can be mid-toggle or showing a push error at a time — this modal
  // is the single entry point for the whole feature, permission included.
  const [pushBusy, setPushBusy] = useState<string | null>(null);
  const [pushError, setPushError] = useState<{ feedId: string; message: string } | null>(null);

  // Turning a feed's bell on also registers this device (asking for notification
  // permission on the first one) — there is no separate "enable notifications"
  // setting to keep in sync. Turning off the last one deregisters it again.
  const handleTogglePush = async (feed: Feed, next: boolean) => {
    setPushError(null);
    setPushBusy(feed.id);
    try {
      if (next) await ensureSubscribed();
      await onUpdate(feed.id, { push_enabled: next });
      if (!next && !feeds.some((f) => f.id !== feed.id && f.push_enabled)) {
        await unsubscribeDevice();
      }
    } catch (e) {
      setPushError({ feedId: feed.id, message: (e as Error).message || '开启推送失败' });
    } finally {
      setPushBusy(null);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(20,18,16,0.45)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        animation: 'fadeInOverlay 0.15s ease',
      }}
    >
      <div
        style={{
          background: 'var(--bg-reader)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          // Fixed 500 would overflow a phone; this modal is reachable on mobile
          // because it owns the per-feed notification toggle.
          width: 'min(500px, calc(100vw - 32px))',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 64px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)',
          animation: 'modalSlideUp 0.18s cubic-bezier(0.34,1.2,0.64,1)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-light)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
            管理订阅源
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{feeds.length} 个</span>
          <button
            onClick={onClose}
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              background: 'var(--bg-hover)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              border: 'none',
              transition: 'background 0.12s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-selected)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
          >
            <X size={14} />
          </button>
        </div>

        {/* Feed list */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0 12px' }}>
          {feeds.length === 0 ? (
            <p
              style={{
                fontSize: 13,
                color: 'var(--text-tertiary)',
                textAlign: 'center',
                padding: '32px 0',
              }}
            >
              暂无订阅源
            </p>
          ) : (
            feeds.map((feed) => (
              <FeedRow
                key={feed.id}
                feed={feed}
                onDelete={onDelete}
                onUpdate={onUpdate}
                onTogglePush={handleTogglePush}
                pushBusy={pushBusy === feed.id}
                pushError={pushError?.feedId === feed.id ? pushError.message : null}
              />
            ))
          )}
        </div>
      </div>

      <style>{`
        @keyframes fadeInOverlay { from{opacity:0} to{opacity:1} }
        @keyframes modalSlideUp { from{opacity:0;transform:translateY(12px) scale(0.97)} to{opacity:1;transform:translateY(0) scale(1)} }
      `}</style>
    </div>,
    document.body,
  );
}

interface FeedRowProps {
  feed: Feed;
  onDelete: (feedId: string) => Promise<void>;
  onUpdate: (feedId: string, patch: { name?: string; push_enabled?: boolean }) => Promise<void>;
  onTogglePush: (feed: Feed, next: boolean) => Promise<void>;
  pushBusy: boolean;
  pushError: string | null;
}

function FeedRow({ feed, onDelete, onUpdate, onTogglePush, pushBusy, pushError }: FeedRowProps) {
  // Touch devices have no hover, so the row actions can never reveal themselves
  // there — on mobile they are simply always visible.
  const isMobile = useIsMobile();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(feed.name);
  const [hovered, setHovered] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  // Deleting a feed also purges its non-starred articles, so it is two-step:
  // the first click arms, the second commits. The icons sit 24px apart, appear
  // under a cursor that is already moving, and 删除 is next to 编辑 — a single
  // misclick should not be able to destroy anything.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = () => {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard) {
      navigator.clipboard
        .writeText(feed.url)
        .then(done)
        .catch(() => fallbackCopy(feed.url, done));
    } else {
      fallbackCopy(feed.url, done);
    }
  };

  useEffect(() => {
    setName(feed.name);
  }, [feed.name]);

  // Never leave a row armed: an unattended armed delete is exactly the state
  // where the next stray click destroys something.
  const disarm = () => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = null;
    setConfirmingDelete(false);
  };

  const handleDelete = () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      disarmTimer.current = setTimeout(() => setConfirmingDelete(false), 3000);
      return;
    }
    disarm();
    void onDelete(feed.id);
  };

  useEffect(
    () => () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    },
    [],
  );

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    await onUpdate(feed.id, { name: name.trim() });
    setSaving(false);
    setEditing(false);
  };

  const handleCancel = () => {
    setName(feed.name);
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') handleCancel();
  };

  const inputStyle: React.CSSProperties = {
    fontSize: 13,
    padding: '4px 8px',
    background: 'var(--bg)',
    border: '1px solid var(--accent)',
    borderRadius: 5,
    color: 'var(--text-primary)',
    outline: 'none',
    fontFamily: 'var(--font-ui)',
  };

  if (editing) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '6px 20px',
          gap: 8,
          background: 'var(--bg-hover)',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <FeedIcon url={feed.url} />
        </span>
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          style={{ ...inputStyle, flex: 1, minWidth: 0 }}
        />
        <button
          onClick={handleSave}
          disabled={saving || !name.trim()}
          title="保存"
          style={{
            width: 26,
            height: 26,
            borderRadius: 5,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: saving ? 'var(--bg-selected)' : 'var(--accent)',
            color: '#fff',
            border: 'none',
            cursor: saving ? 'default' : 'pointer',
          }}
        >
          <Check size={12} />
        </button>
        <button
          onClick={handleCancel}
          title="取消"
          style={{
            width: 26,
            height: 26,
            borderRadius: 5,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-selected)',
            color: 'var(--text-secondary)',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  const pushOn = feed.push_enabled === true;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        disarm();
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '7px 20px',
        gap: 8,
        background: hovered ? 'var(--bg-hover)' : 'transparent',
        transition: 'background 0.1s',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <FeedIcon url={feed.url} />
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 13,
          color: 'var(--text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {feed.name}
      </span>
      {/* The bell stays visible once on: an active push subscription is state the
          user must be able to see without hovering (and without a mouse at all). */}
      {(hovered || pushOn || isMobile) && (
        <ActionBtn
          onClick={() => {
            if (!pushBusy) void onTogglePush(feed, !pushOn);
          }}
          title={pushOn ? '关闭更新推送' : '开启更新推送'}
          color={pushOn ? 'var(--accent)' : 'var(--text-tertiary)'}
          hoverColor="var(--accent)"
          isMobile={isMobile}
        >
          {pushOn ? <Bell size={11} /> : <BellOff size={11} />}
        </ActionBtn>
      )}
      {/* Gap, not just spacing: the bell is a state toggle, the three that follow
          are actions. Crowding them into one strip read as a single group. */}
      {(hovered || isMobile) && (
        <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginLeft: 6 }}>
          <ActionBtn
            onClick={handleCopy}
            title={copied ? '已复制' : '复制链接'}
            color={copied ? 'var(--accent)' : 'var(--text-tertiary)'}
            hoverColor="var(--accent)"
            isMobile={isMobile}
          >
            {copied ? <CopyCheck size={11} /> : <Copy size={11} />}
          </ActionBtn>
          <ActionBtn
            onClick={() => setEditing(true)}
            title="编辑"
            color="var(--text-tertiary)"
            hoverColor="var(--accent)"
            isMobile={isMobile}
          >
            <Pencil size={11} />
          </ActionBtn>
          <ActionBtn
            onClick={handleDelete}
            title={confirmingDelete ? '再点一次确认删除' : '删除'}
            color={confirmingDelete ? 'var(--red)' : 'var(--text-tertiary)'}
            hoverColor="var(--red)"
            isMobile={isMobile}
            armed={confirmingDelete}
          >
            {confirmingDelete ? <Check size={11} /> : <Trash2 size={11} />}
          </ActionBtn>
        </div>
      )}
      {pushError && (
        <p
          style={{
            flexBasis: '100%',
            margin: '2px 0 0 22px',
            fontSize: 11.5,
            color: 'var(--red)',
            lineHeight: 1.5,
          }}
        >
          {pushError}
        </p>
      )}
    </div>
  );
}

interface ActionBtnProps {
  onClick: () => void;
  title: string;
  color: string;
  hoverColor: string;
  isMobile?: boolean;
  /** Armed buttons keep their highlight instead of fading back on mouse-out. */
  armed?: boolean;
  children: React.ReactNode;
}

function ActionBtn({
  onClick,
  title,
  color,
  hoverColor,
  isMobile,
  armed,
  children,
}: ActionBtnProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        // 24px is a fine mouse target and a poor finger one.
        width: isMobile ? 34 : 24,
        height: isMobile ? 34 : 24,
        borderRadius: 4,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color,
        background: armed ? 'var(--bg-selected)' : 'none',
        border: 'none',
        cursor: 'pointer',
        transition: 'color 0.12s, background 0.12s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = hoverColor;
        e.currentTarget.style.background = 'var(--bg-selected)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = color;
        e.currentTarget.style.background = armed ? 'var(--bg-selected)' : 'none';
      }}
    >
      {children}
    </button>
  );
}
