import { useState } from 'react';

interface LoginFormProps {
  onLogin: () => void;
}

export default function LoginForm({ onLogin }: LoginFormProps) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, pass }),
        credentials: 'same-origin',
      });
      const data = await r.json();
      if (r.ok) {
        onLogin();
      } else {
        setError(data.error || '用户名或密码错误');
        setLoading(false);
      }
    } catch {
      setError('网络错误，请重试');
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100dvh',
        background: 'var(--bg)',
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: 'var(--bg-reader)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '36px 32px',
          width: 320,
          maxWidth: '90vw',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 4 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>
            RSS Reader
          </div>
        </div>
        <input
          type="text"
          placeholder="用户名"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          required
          style={{
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            color: 'var(--text-primary)',
            fontSize: 15,
            outline: 'none',
            fontFamily: 'var(--font-ui)',
          }}
        />
        <input
          type="password"
          placeholder="密码"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          required
          style={{
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            color: 'var(--text-primary)',
            fontSize: 15,
            outline: 'none',
            fontFamily: 'var(--font-ui)',
          }}
        />
        {error && (
          <div style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center' }}>{error}</div>
        )}
        <button
          type="submit"
          disabled={loading || !user || !pass}
          style={{
            padding: '10px',
            borderRadius: 8,
            border: 'none',
            background: loading || !user || !pass ? 'var(--bg-selected)' : 'var(--accent)',
            color: loading || !user || !pass ? 'var(--text-tertiary)' : '#fff',
            fontSize: 15,
            fontWeight: 600,
            cursor: loading || !user || !pass ? 'default' : 'pointer',
            fontFamily: 'var(--font-ui)',
            transition: 'background 0.15s',
          }}
        >
          {loading ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
