import { X, CheckCircle } from 'lucide-react';
import { useState, useEffect } from 'react';

import type { LLMConfig } from '../types';
import ModalOverlay from './ModalOverlay';

interface SettingsModalProps {
  onClose: () => void;
}

const sectionStyle: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
  marginBottom: 12,
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11.5,
  fontWeight: 500,
  color: 'var(--text-secondary)',
  marginBottom: 5,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 13,
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 7,
  color: 'var(--text-primary)',
  outline: 'none',
  transition: 'border-color 0.15s',
  fontFamily: 'monospace',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: 7,
  fontSize: 13,
  fontWeight: 500,
  background: 'var(--accent)',
  color: '#fff',
  border: 'none',
  transition: 'background 0.15s',
  whiteSpace: 'nowrap',
  display: 'flex',
  alignItems: 'center',
  gap: 5,
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 7,
  fontSize: 13,
  fontWeight: 500,
  background: 'var(--bg-selected)',
  color: 'var(--text-secondary)',
  border: 'none',
  whiteSpace: 'nowrap',
};

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [rsshubBase, setRsshubBase] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Translation service. `keySet` is all the server will say about the API key —
  // it is never returned, so the input starts empty and only a non-empty submit
  // replaces it. `editingKey` is what reveals the field once one is stored.
  const [llmBase, setLlmBase] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [keySet, setKeySet] = useState(false);
  // The switch is the intent, the key is the capability — both are needed before
  // anything is translated, which is why the checkbox is disabled without a key
  // rather than silently doing nothing.
  const [llmEnabled, setLlmEnabled] = useState(false);
  const [llmKey, setLlmKey] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [llmDirty, setLlmDirty] = useState(false);
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmSaved, setLlmSaved] = useState(false);
  const [llmError, setLlmError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  // The key input is on screen when there is nothing stored yet, or when 更改
  // opened it. This is also what decides whether a save carries the key.
  const keyEditable = !keySet || editingKey;

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s) => setRsshubBase(s.rsshub_base_url || 'http://localhost:1200'))
      .catch(() => setRsshubBase('http://localhost:1200'));
  }, []);

  useEffect(() => {
    fetch('/api/llm/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((c: LLMConfig | null) => {
        if (!c) return;
        setLlmBase(c.base_url);
        setLlmModel(c.model);
        setKeySet(c.key_set);
        setLlmEnabled(c.enabled);
      })
      .catch(() => {});
  }, []);

  const handleSaveLLM = async () => {
    setLlmSaving(true);
    setLlmError('');
    setLlmSaved(false);
    setTestResult(null);
    try {
      // The key rides along exactly when its input is on screen — which is either
      // because none is stored yet, or because 更改 opened it. Keying this off
      // `editingKey` alone would silently drop the very first key ever entered,
      // since the initial empty state shows the input without any 更改 to click.
      // When it is hidden, a model-only edit cannot blank a stored credential the
      // browser never saw.
      const patch: Record<string, string | boolean> = {
        base_url: llmBase.trim(),
        model: llmModel.trim(),
        enabled: llmEnabled,
      };
      if (keyEditable) patch.api_key = llmKey.trim();
      const r = await fetch('/api/llm/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || '保存失败');
      if (keyEditable) {
        setKeySet(llmKey.trim() !== '');
        setLlmKey('');
        setEditingKey(false);
      }
      setLlmDirty(false);
      setLlmSaved(true);
      setTimeout(() => setLlmSaved(false), 2500);
    } catch (err) {
      setLlmError((err as Error).message || '保存失败');
    } finally {
      setLlmSaving(false);
    }
  };

  // Runs one real translation through the stored config. A health check would pass
  // on a wrong model name or a key without chat permission and still leave every
  // title untranslated, so this exercises the path the worker actually uses.
  const handleTestLLM = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch('/api/llm/config/test', { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      setTestResult(
        body.ok
          ? { ok: true, message: '连接成功' }
          : { ok: false, message: body.error || '连接失败' },
      );
    } catch {
      setTestResult({ ok: false, message: '连接失败' });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    const val = rsshubBase.trim();
    if (!val) return;
    setSaving(true);
    setError('');
    setSaved(false);
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
      setError((err as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalOverlay onClose={onClose}>
      <div
        style={{
          background: 'var(--bg-reader)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          width: 420,
          boxShadow: '0 24px 64px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)',
          animation: 'modalSlideUp 0.18s cubic-bezier(0.34,1.2,0.64,1)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '18px 20px 14px',
            borderBottom: '1px solid var(--border-light)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>设置</span>
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

        {/* Body */}
        <div style={{ padding: '20px 20px 24px' }}>
          {/* Section: RSSHub */}
          <p style={sectionStyle}>RSSHub</p>

          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>实例地址</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={rsshubBase}
                onChange={(e) => {
                  setRsshubBase(e.target.value);
                  setSaved(false);
                }}
                placeholder="http://localhost:1200"
                style={{
                  flex: 1,
                  padding: '8px 10px',
                  fontSize: 13,
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 7,
                  color: 'var(--text-primary)',
                  outline: 'none',
                  transition: 'border-color 0.15s',
                  fontFamily: 'monospace',
                }}
                onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
                onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
              />
              <button
                onClick={handleSave}
                disabled={saving || !rsshubBase.trim()}
                style={{
                  padding: '8px 16px',
                  borderRadius: 7,
                  fontSize: 13,
                  fontWeight: 500,
                  background: saved
                    ? 'var(--accent)'
                    : saving || !rsshubBase.trim()
                      ? 'var(--bg-selected)'
                      : 'var(--accent)',
                  color: saving || !rsshubBase.trim() ? 'var(--text-tertiary)' : '#fff',
                  border: 'none',
                  cursor: saving || !rsshubBase.trim() ? 'default' : 'pointer',
                  opacity: saving || !rsshubBase.trim() ? 0.7 : 1,
                  transition: 'background 0.15s',
                  whiteSpace: 'nowrap',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                {saved ? (
                  <>
                    <CheckCircle size={13} /> 已保存
                  </>
                ) : saving ? (
                  '保存中…'
                ) : (
                  '保存'
                )}
              </button>
            </div>
            <p
              style={{
                fontSize: 11.5,
                color: 'var(--text-tertiary)',
                marginTop: 6,
                lineHeight: 1.6,
              }}
            >
              订阅 <code style={{ fontFamily: 'monospace' }}>rsshub://路由</code>{' '}
              时自动替换为此地址。 保存后所有 RSSHub 订阅将使用新地址重新抓取。
            </p>
          </div>

          {error && <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{error}</p>}

          {/* Section: translation service */}
          <p style={{ ...sectionStyle, marginTop: 24 }}>翻译服务</p>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>API 地址</label>
            <input
              type="text"
              value={llmBase}
              onChange={(e) => {
                setLlmBase(e.target.value);
                setLlmDirty(true);
              }}
              placeholder="https://api.deepseek.com"
              style={inputStyle}
              onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
              onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>模型</label>
            <input
              type="text"
              value={llmModel}
              onChange={(e) => {
                setLlmModel(e.target.value);
                setLlmDirty(true);
              }}
              placeholder="deepseek-chat"
              style={inputStyle}
              onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
              onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>API Key</label>
            {!keyEditable ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    flex: 1,
                    fontSize: 13,
                    fontFamily: 'monospace',
                    color: 'var(--text-tertiary)',
                    letterSpacing: '0.15em',
                  }}
                >
                  ••••••••••••
                </span>
                <button
                  onClick={() => {
                    setEditingKey(true);
                    setLlmDirty(true);
                  }}
                  style={secondaryBtnStyle}
                >
                  更改
                </button>
              </div>
            ) : (
              <input
                type="password"
                value={llmKey}
                onChange={(e) => {
                  setLlmKey(e.target.value);
                  setLlmDirty(true);
                }}
                placeholder="sk-…"
                autoComplete="off"
                style={inputStyle}
                onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
                onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
              />
            )}
          </div>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 14,
              fontSize: 13,
              color: keySet ? 'var(--text-primary)' : 'var(--text-tertiary)',
              cursor: keySet ? 'pointer' : 'default',
            }}
            title={keySet ? '' : '请先填写并保存 API Key'}
          >
            <input
              type="checkbox"
              checked={llmEnabled}
              disabled={!keySet}
              onChange={(e) => {
                setLlmEnabled(e.target.checked);
                setLlmDirty(true);
              }}
              style={{ cursor: keySet ? 'pointer' : 'default' }}
            />
            翻译文章标题
          </label>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              onClick={handleSaveLLM}
              disabled={llmSaving}
              style={{
                ...primaryBtnStyle,
                opacity: llmSaving ? 0.7 : 1,
                cursor: llmSaving ? 'default' : 'pointer',
              }}
            >
              {llmSaved ? (
                <>
                  <CheckCircle size={13} /> 已保存
                </>
              ) : llmSaving ? (
                '保存中…'
              ) : (
                '保存'
              )}
            </button>
            {/* Tests what is stored, so unsaved edits would test the wrong thing. */}
            <button
              onClick={handleTestLLM}
              disabled={testing || llmDirty || !keySet}
              title={llmDirty ? '请先保存' : !keySet ? '请先填写 API Key' : '发送一次真实翻译请求'}
              style={{
                ...secondaryBtnStyle,
                opacity: testing || llmDirty || !keySet ? 0.5 : 1,
                cursor: testing || llmDirty || !keySet ? 'default' : 'pointer',
              }}
            >
              {testing ? '测试中…' : '测试连接'}
            </button>
            {testResult && (
              <span
                style={{
                  fontSize: 12,
                  color: testResult.ok ? 'var(--accent)' : 'var(--red)',
                }}
              >
                {testResult.message}
              </span>
            )}
          </div>
          {llmError && (
            <p style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{llmError}</p>
          )}
          <p
            style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 8, lineHeight: 1.6 }}
          >
            任何兼容 OpenAI <code style={{ fontFamily: 'monospace' }}>/chat/completions</code>{' '}
            的服务均可（DeepSeek、Moonshot、OpenRouter、本机 Ollama 等）。
            开启后非中文标题会译成中文显示，原标题保留在下方；中文标题自动跳过，不消耗额度。
            开启时仅回溯最近 24 小时，更早的文章不会翻译。
          </p>
        </div>
      </div>
    </ModalOverlay>
  );
}
