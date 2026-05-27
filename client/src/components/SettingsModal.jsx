import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, CheckCircle } from 'lucide-react';

export default function SettingsModal({ onClose }) {
  const [rsshubBase, setRsshubBase] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(s => setRsshubBase(s.rsshub_base_url || 'http://localhost:1200'))
      .catch(() => setRsshubBase('http://localhost:1200'));
  }, []);

  const handleSave = async () => {
    const val = rsshubBase.trim();
    if (!val) return;
    setSaving(true); setError(''); setSaved(false);
    try {
      const r = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rsshub_base_url: val }),
      });
      if (!r.ok) throw new Error('保存失败');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
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
        width: 420,
        boxShadow: '0 24px 64px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)',
        animation: 'modalSlideUp 0.18s cubic-bezier(0.34,1.2,0.64,1)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '18px 20px 14px',
          borderBottom: '1px solid var(--border-light)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>设置</span>
          <button
            onClick={onClose}
            style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--bg-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', cursor: 'pointer', border: 'none', transition: 'background 0.12s' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-selected)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-hover)'}
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 20px 24px' }}>
          {/* Section: RSSHub */}
          <p style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 12 }}>
            RSSHub
          </p>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 5 }}>
              实例地址
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={rsshubBase}
                onChange={e => { setRsshubBase(e.target.value); setSaved(false); }}
                placeholder="http://localhost:1200"
                style={{
                  flex: 1, padding: '8px 10px', fontSize: 13,
                  background: 'var(--bg)', border: '1px solid var(--border)',
                  borderRadius: 7, color: 'var(--text-primary)', outline: 'none',
                  transition: 'border-color 0.15s', fontFamily: 'monospace',
                }}
                onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
              />
              <button
                onClick={handleSave}
                disabled={saving || !rsshubBase.trim()}
                style={{
                  padding: '8px 16px', borderRadius: 7, fontSize: 13, fontWeight: 500,
                  background: saved ? 'var(--accent)' : (saving || !rsshubBase.trim() ? 'var(--bg-selected)' : 'var(--accent)'),
                  color: (saving || !rsshubBase.trim()) ? 'var(--text-tertiary)' : '#fff',
                  border: 'none', cursor: (saving || !rsshubBase.trim()) ? 'default' : 'pointer',
                  opacity: (saving || !rsshubBase.trim()) ? 0.7 : 1,
                  transition: 'background 0.15s', whiteSpace: 'nowrap',
                  display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                {saved ? <><CheckCircle size={13} /> 已保存</> : (saving ? '保存中…' : '保存')}
              </button>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 6, lineHeight: 1.6 }}>
              订阅 <code style={{ fontFamily: 'monospace' }}>rsshub://路由</code> 时自动替换为此地址。
              保存后所有 RSSHub 订阅将使用新地址重新抓取。
            </p>
          </div>

          {error && (
            <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{error}</p>
          )}
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
