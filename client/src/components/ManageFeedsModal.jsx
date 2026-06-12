import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, Trash2, Pencil, Rss, Copy, CopyCheck } from 'lucide-react';

function fallbackCopy(text, onDone) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); onDone(); } catch {}
  document.body.removeChild(ta);
}

function FeedIcon({ url }) {
  const [failed, setFailed] = useState(false);
  let domain = '';
  try { domain = new URL(url).hostname; } catch {}
  if (failed || !domain) return <Rss size={13} style={{ color: 'var(--text-tertiary)' }} />;
  return (
    <img src={`/api/favicon?domain=${domain}`}
      alt="" width={14} height={14}
      style={{ borderRadius: 3, objectFit: 'contain', flexShrink: 0 }}
      onError={() => setFailed(true)} />
  );
}

export default function ManageFeedsModal({ feeds, onClose, onDelete, onUpdate }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(20,18,16,0.45)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000,
        animation: 'fadeInOverlay 0.15s ease',
      }}
    >
      <div style={{
        background: 'var(--bg-reader)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        width: 500,
        maxHeight: '80vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 24px 64px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)',
        animation: 'modalSlideUp 0.18s cubic-bezier(0.34,1.2,0.64,1)',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--border-light)',
          display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>管理订阅源</span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{feeds.length} 个</span>
          <button
            onClick={onClose}
            style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--bg-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', cursor: 'pointer', border: 'none', transition: 'background 0.12s' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-selected)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-hover)'}
          >
            <X size={14} />
          </button>
        </div>

        {/* Feed list */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0 12px' }}>
          {feeds.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-tertiary)', textAlign: 'center', padding: '32px 0' }}>
              暂无订阅源
            </p>
          ) : feeds.map(feed => (
            <FeedRow key={feed.id} feed={feed} onDelete={onDelete} onUpdate={onUpdate} />
          ))}
        </div>
      </div>

      <style>{`
        @keyframes fadeInOverlay { from{opacity:0} to{opacity:1} }
        @keyframes modalSlideUp { from{opacity:0;transform:translateY(12px) scale(0.97)} to{opacity:1;transform:translateY(0) scale(1)} }
      `}</style>
    </div>,
    document.body
  );
}

function FeedRow({ feed, onDelete, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(feed.name);
  const [hovered, setHovered] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const nameRef = useRef(null);

  const handleCopy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(feed.url).then(done).catch(() => fallbackCopy(feed.url, done));
    } else {
      fallbackCopy(feed.url, done);
    }
  };

  useEffect(() => {
    setName(feed.name);
  }, [feed.name]);

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

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') handleCancel();
  };

  const inputStyle = {
    fontSize: 13, padding: '4px 8px',
    background: 'var(--bg)', border: '1px solid var(--accent)',
    borderRadius: 5, color: 'var(--text-primary)', outline: 'none',
    fontFamily: 'var(--font-ui)',
  };

  if (editing) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '6px 20px', gap: 8,
        background: 'var(--bg-hover)',
      }}>
        <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <FeedIcon url={feed.url} />
        </span>
        <input
          ref={nameRef}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          style={{ ...inputStyle, flex: 1, minWidth: 0 }}
        />
        <button
          onClick={handleSave}
          disabled={saving || !name.trim()}
          title="保存"
          style={{
            width: 26, height: 26, borderRadius: 5, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: saving ? 'var(--bg-selected)' : 'var(--accent)',
            color: '#fff', border: 'none', cursor: saving ? 'default' : 'pointer',
          }}
        >
          <Check size={12} />
        </button>
        <button
          onClick={handleCancel}
          title="取消"
          style={{
            width: 26, height: 26, borderRadius: 5, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--bg-selected)', color: 'var(--text-secondary)',
            border: 'none', cursor: 'pointer',
          }}
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center',
        padding: '7px 20px', gap: 8,
        background: hovered ? 'var(--bg-hover)' : 'transparent',
        transition: 'background 0.1s',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <FeedIcon url={feed.url} />
      </span>
      <span style={{
        flex: 1, fontSize: 13, color: 'var(--text-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {feed.name}
      </span>
      {hovered && (
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <ActionBtn onClick={handleCopy} title={copied ? '已复制' : '复制链接'} color={copied ? 'var(--accent)' : 'var(--text-tertiary)'} hoverColor="var(--accent)">
            {copied ? <CopyCheck size={11} /> : <Copy size={11} />}
          </ActionBtn>
          <ActionBtn onClick={() => setEditing(true)} title="编辑" color="var(--text-tertiary)" hoverColor="var(--accent)">
            <Pencil size={11} />
          </ActionBtn>
          <ActionBtn onClick={() => onDelete(feed.id)} title="删除" color="var(--text-tertiary)" hoverColor="var(--red)">
            <Trash2 size={11} />
          </ActionBtn>
        </div>
      )}
    </div>
  );
}

function ActionBtn({ onClick, title, color, hoverColor, children }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 24, height: 24, borderRadius: 4, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color, background: 'none', border: 'none', cursor: 'pointer',
        transition: 'color 0.12s, background 0.12s',
      }}
      onMouseEnter={e => { e.currentTarget.style.color = hoverColor; e.currentTarget.style.background = 'var(--bg-selected)'; }}
      onMouseLeave={e => { e.currentTarget.style.color = color; e.currentTarget.style.background = 'none'; }}
    >
      {children}
    </button>
  );
}
