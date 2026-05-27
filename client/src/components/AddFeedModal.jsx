import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Upload, CheckCircle, AlertCircle } from 'lucide-react';

export default function AddFeedModal({ onClose, onAdd, onImport }) {
  const [tab, setTab] = useState('manual');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
        <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {/* Tabs */}
          <div style={{ display: 'flex', gap: 2, background: 'var(--bg-panel)', borderRadius: 7, padding: 3 }}>
            {[['manual', '手动添加'], ['opml', '导入 OPML']].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  padding: '4px 12px', borderRadius: 5, fontSize: 12.5, fontWeight: 500,
                  background: tab === key ? 'var(--bg-reader)' : 'transparent',
                  color: tab === key ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  border: tab === key ? '1px solid var(--border)' : '1px solid transparent',
                  cursor: 'pointer',
                  boxShadow: tab === key ? '0 1px 3px rgba(0,0,0,0.07)' : 'none',
                  transition: 'all 0.15s',
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--bg-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', cursor: 'pointer', border: 'none', transition: 'background 0.12s' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-selected)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-hover)'}
          >
            <X size={14} />
          </button>
        </div>

        {tab === 'manual'
          ? <ManualTab onAdd={onAdd} onClose={onClose} />
          : <OpmlTab onImport={onImport} onClose={onClose} />}
      </div>

      <style>{`
        @keyframes fadeInOverlay { from{opacity:0} to{opacity:1} }
        @keyframes modalSlideUp { from{opacity:0;transform:translateY(12px) scale(0.97)} to{opacity:1;transform:translateY(0) scale(1)} }
      `}</style>
    </div>,
    document.body
  );
}

// ── Manual Tab ────────────────────────────────────────────────────────────────
function ManualTab({ onAdd, onClose }) {
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [rsshubBase, setRsshubBase] = useState('http://localhost:1200');
  const urlRef = useRef(null);

  useEffect(() => { urlRef.current?.focus(); }, []);
  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(s => {
      if (s.rsshub_base_url) setRsshubBase(s.rsshub_base_url);
    }).catch(() => {});
  }, []);

  const isRsshub = url.trim().startsWith('rsshub://');
  const resolvedPreview = isRsshub
    ? rsshubBase.replace(/\/$/, '') + '/' + url.trim().slice('rsshub://'.length)
    : null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true); setError('');
    try {
      await onAdd({ url: url.trim() });
      onClose();
    } catch (err) {
      setError(err.message || '添加失败，请检查 URL 是否正确');
    } finally {
      setAdding(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ padding: '18px 20px 20px' }}>
      <Field ref={urlRef} label="Feed URL" placeholder="https://example.com/feed.xml 或 rsshub://路由/路径" value={url} onChange={setUrl} required />
      {resolvedPreview && (
        <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: -8, marginBottom: 12, lineHeight: 1.5 }}>
          → <span style={{ color: 'var(--accent)', fontFamily: 'monospace' }}>{resolvedPreview}</span>
        </p>
      )}
      {!isRsshub && !error && (
        <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: -8, marginBottom: 12 }}>
          💡 支持 <code style={{ fontFamily: 'monospace', color: 'var(--text-secondary)' }}>rsshub://路由/路径</code> 格式
        </p>
      )}
      {error && <p style={{ fontSize: 12, color: 'var(--red)', marginBottom: 14 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <GhostBtn onClick={onClose}>取消</GhostBtn>
        <PrimaryBtn type="submit" disabled={adding || !url.trim()}>{adding ? '解析中…' : '添加'}</PrimaryBtn>
      </div>
    </form>
  );
}

// ── OPML Tab ──────────────────────────────────────────────────────────────────
function OpmlTab({ onImport, onClose }) {
  const [phase, setPhase] = useState('idle'); // idle | importing | done | error
  const [dragOver, setDragOver] = useState(false);
  const [result, setResult] = useState(null); // { imported, skipped, feeds }
  const [errMsg, setErrMsg] = useState('');
  const inputRef = useRef(null);

  const processFile = async (file) => {
    if (!file) return;
    setPhase('importing');
    try {
      const text = await file.text();
      const r = await fetch('/api/feeds/import-opml', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opml: text }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Import failed');
      setResult(data);
      setPhase('done');
      onImport(data.feeds);
    } catch (err) {
      setErrMsg(err.message);
      setPhase('error');
    }
  };

  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  };

  return (
    <div style={{ padding: '18px 20px 20px' }}>
      {phase === 'idle' || phase === 'importing' ? (
        <>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => phase === 'idle' && inputRef.current?.click()}
            style={{
              border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 10,
              padding: '32px 20px',
              textAlign: 'center',
              cursor: phase === 'importing' ? 'default' : 'pointer',
              background: dragOver ? 'rgba(43,92,92,0.04)' : 'var(--bg)',
              transition: 'border-color 0.15s, background 0.15s',
              marginBottom: 16,
            }}
          >
            {phase === 'importing' ? (
              <>
                <span style={{ width: 28, height: 28, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite', marginBottom: 10 }} />
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>解析中…</p>
              </>
            ) : (
              <>
                <Upload size={28} style={{ color: dragOver ? 'var(--accent)' : 'var(--text-tertiary)', marginBottom: 10 }} />
                <p style={{ fontSize: 13.5, color: 'var(--text-primary)', margin: '0 0 4px', fontWeight: 500 }}>
                  拖拽 OPML 文件至此
                </p>
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '0 0 14px' }}>
                  支持 .opml 和 .xml 格式
                </p>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
                  style={{ fontSize: 12.5, color: 'var(--accent)', padding: '5px 14px', border: '1px solid var(--accent)', borderRadius: 6, cursor: 'pointer', background: 'none', fontWeight: 500 }}
                >
                  选择文件
                </button>
              </>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".opml,.xml"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) processFile(f); e.target.value = ''; }}
          />
          <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', margin: 0, lineHeight: 1.6 }}>
            OPML 是订阅源的通用导出格式，可从 Feedly、Reeder、NetNewsWire 等应用导出。
          </p>
        </>
      ) : phase === 'done' ? (
        <div style={{ textAlign: 'center', padding: '12px 0 8px' }}>
          <CheckCircle size={36} style={{ color: 'var(--accent)', marginBottom: 12 }} />
          <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px' }}>
            导入完成
          </p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 4px' }}>
            成功导入 <strong>{result.imported}</strong> 个订阅源
          </p>
          {result.skipped > 0 && (
            <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '0 0 20px' }}>
              跳过 {result.skipped} 个重复项
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 20 }}>
            <GhostBtn onClick={() => { setPhase('idle'); setResult(null); }}>再次导入</GhostBtn>
            <PrimaryBtn onClick={onClose}>完成</PrimaryBtn>
          </div>
        </div>
      ) : (
        <div style={{ textAlign: 'center', padding: '12px 0 8px' }}>
          <AlertCircle size={36} style={{ color: 'var(--red)', marginBottom: 12 }} />
          <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px' }}>解析失败</p>
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '0 0 20px' }}>{errMsg}</p>
          <GhostBtn onClick={() => { setPhase('idle'); setErrMsg(''); }}>重试</GhostBtn>
        </div>
      )}
    </div>
  );
}

// ── Shared UI ─────────────────────────────────────────────────────────────────
function Field({ label, placeholder, value, onChange, required, ref: fRef }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 11.5, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 5 }}>
        {label}{required && <span style={{ color: 'var(--accent)', marginLeft: 2 }}>*</span>}
      </label>
      <input
        ref={fRef}
        type="text" value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} required={required}
        style={{ width: '100%', padding: '8px 10px', fontSize: 13, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-primary)', outline: 'none', transition: 'border-color 0.15s', boxSizing: 'border-box' }}
        onFocus={e => e.target.style.borderColor = 'var(--accent)'}
        onBlur={e => e.target.style.borderColor = 'var(--border)'}
      />
    </div>
  );
}

function GhostBtn({ onClick, children }) {
  return (
    <button type="button" onClick={onClick} style={{ padding: '7px 16px', borderRadius: 7, fontSize: 13, color: 'var(--text-secondary)', background: 'var(--bg-hover)', border: '1px solid var(--border)', cursor: 'pointer', transition: 'background 0.12s', fontFamily: 'inherit' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-selected)'}
      onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-hover)'}
    >{children}</button>
  );
}

function PrimaryBtn({ onClick, type = 'button', disabled, children }) {
  return (
    <button type={type} onClick={onClick} disabled={disabled} style={{ padding: '7px 20px', borderRadius: 7, fontSize: 13, fontWeight: 500, background: disabled ? 'var(--bg-selected)' : 'var(--accent)', color: disabled ? 'var(--text-tertiary)' : '#fff', border: 'none', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.7 : 1, transition: 'background 0.15s', fontFamily: 'inherit' }}
    >{children}</button>
  );
}
