import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export default function AddFeedModal({ onClose, onAdd }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const urlRef = useRef(null);

  useEffect(() => {
    urlRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true);
    setError('');
    try {
      await onAdd({ url: url.trim(), name: name.trim(), category: category.trim() });
      onClose();
    } catch {
      setError('添加失败，请检查 URL 是否正确');
    } finally {
      setAdding(false);
    }
  };

  return createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(20, 18, 16, 0.45)',
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
        width: 400,
        boxShadow: '0 24px 64px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)',
        animation: 'modalSlideUp 0.18s cubic-bezier(0.34,1.2,0.64,1)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--border-light)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
              添加订阅源
            </h2>
            <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              粘贴 RSS / Atom feed 链接
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 28, height: 28, borderRadius: 6,
              background: 'var(--bg-hover)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-secondary)',
              lineHeight: 1,
              transition: 'background 0.12s',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-selected)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-hover)'}
          >
            <X size={14} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ padding: '20px 24px 24px' }}>
          <Field
            ref={urlRef}
            label="Feed URL"
            placeholder="https://example.com/feed.xml"
            value={url}
            onChange={setUrl}
            required
          />
          <Field
            label="名称"
            placeholder="（可选，默认使用 Feed 标题）"
            value={name}
            onChange={setName}
          />
          <Field
            label="分类"
            placeholder="（可选，如：科技、新闻）"
            value={category}
            onChange={setCategory}
          />

          {error && (
            <p style={{ fontSize: 12, color: 'var(--red)', marginBottom: 14 }}>{error}</p>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '7px 16px',
                borderRadius: 7,
                fontSize: 13,
                color: 'var(--text-secondary)',
                background: 'var(--bg-hover)',
                border: '1px solid var(--border)',
                transition: 'background 0.12s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-selected)'}
              onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-hover)'}
            >
              取消
            </button>
            <button
              type="submit"
              disabled={adding || !url.trim()}
              style={{
                padding: '7px 20px',
                borderRadius: 7,
                fontSize: 13,
                fontWeight: 500,
                background: url.trim() ? 'var(--accent)' : 'var(--bg-selected)',
                color: url.trim() ? '#fff' : 'var(--text-tertiary)',
                border: 'none',
                cursor: url.trim() ? 'pointer' : 'default',
                transition: 'background 0.15s, color 0.15s, opacity 0.15s',
                opacity: adding ? 0.7 : 1,
              }}
            >
              {adding ? '添加中…' : '添加'}
            </button>
          </div>
        </form>
      </div>

      <style>{`
        @keyframes fadeInOverlay {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes modalSlideUp {
          from { opacity: 0; transform: translateY(12px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>,
    document.body
  );
}

function Field({ label, placeholder, value, onChange, required, ref: forwardedRef }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{
        display: 'block',
        fontSize: 11.5,
        fontWeight: 500,
        color: 'var(--text-secondary)',
        marginBottom: 5,
        letterSpacing: '0.02em',
      }}>
        {label}{required && <span style={{ color: 'var(--accent)', marginLeft: 2 }}>*</span>}
      </label>
      <input
        ref={forwardedRef}
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        style={{
          width: '100%',
          padding: '8px 10px',
          fontSize: 13,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 7,
          color: 'var(--text-primary)',
          outline: 'none',
          transition: 'border-color 0.15s',
        }}
        onFocus={e => e.target.style.borderColor = 'var(--accent)'}
        onBlur={e => e.target.style.borderColor = 'var(--border)'}
      />
    </div>
  );
}
