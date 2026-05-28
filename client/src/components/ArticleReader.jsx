import { useState, useEffect } from 'react';
import { Star, AlignLeft, Mic, Play, Pause, ChevronLeft } from 'lucide-react';

function formatFullDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function ArticleReader({ isMobile, onBack, article, onToggleStar, onPlay, currentEpisode, isPlaying }) {
  const [fullContent, setFullContent] = useState(null);

  useEffect(() => { setFullContent(null); }, [article?.id]);

  const handleFetchFull = async () => {
    if (!article?.link) return;
    setFullContent('loading');
    try {
      const r = await fetch(`/api/fetch-content?url=${encodeURIComponent(article.link)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'failed');
      setFullContent({ html: data.content });
    } catch (err) {
      setFullContent({ error: err.message });
    }
  };

  if (!article) {
    if (isMobile) return null;
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-reader)',
        flexDirection: 'column',
        gap: 12,
      }}>
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none" opacity="0.15">
          <rect x="8" y="10" width="32" height="28" rx="3" stroke="#141210" strokeWidth="2"/>
          <path d="M14 18h20M14 24h20M14 30h12" stroke="#141210" strokeWidth="2" strokeLinecap="round"/>
        </svg>
        <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>选择一篇文章开始阅读</p>
      </div>
    );
  }

  const rawContent = fullContent?.html || article.content || article.summary || '';
  const hasHtml = /<[a-z][\s\S]*>/i.test(rawContent);

  return (
    <div
      key={article.id}
      style={{
        flex: 1,
        background: 'var(--bg-reader)',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        animation: 'fadeIn 0.2s ease',
        display: 'flex',
        flexDirection: 'column',
        height: isMobile ? '100%' : undefined,
      }}
    >
      {/* Mobile back header */}
      {isMobile && (
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '0 12px',
          height: 52, flexShrink: 0,
          borderBottom: '1px solid var(--border-light)',
          background: 'var(--bg-reader)',
          position: 'sticky', top: 0, zIndex: 10,
        }}>
          <button
            onClick={onBack}
            style={{
              display: 'flex', alignItems: 'center', gap: 2,
              color: 'var(--accent)', background: 'none', border: 'none',
              cursor: 'pointer', padding: '6px 8px 6px 0', fontSize: 15,
              flexShrink: 0,
            }}
          >
            <ChevronLeft size={20} strokeWidth={2} />
            文章列表
          </button>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => onToggleStar(article)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: article.isStarred ? '#F5C518' : 'var(--text-tertiary)',
              display: 'flex', alignItems: 'center', padding: 6, borderRadius: 5,
            }}
          >
            <Star size={18} fill={article.isStarred ? '#F5C518' : 'none'} strokeWidth={1.5} />
          </button>
          {article.link && (
            <a
              href={article.link}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex', alignItems: 'center', gap: 3,
                fontSize: 13, color: 'var(--accent)',
                textDecoration: 'none', padding: 6,
              }}
            >
              原文
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                <path d="M2 10L10 2M10 2H5M10 2v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </a>
          )}
        </div>
      )}

      <div style={{
        maxWidth: 680,
        width: '100%',
        margin: '0 auto',
        padding: isMobile ? '24px 20px 80px' : '48px 48px 80px',
      }}>
        {/* Feed name */}
        {article.feedName && (
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--accent)',
            marginBottom: 12,
          }}>
            {article.feedName}
          </div>
        )}

        {/* Title */}
        <h1 style={{
          fontFamily: 'var(--font-serif)',
          fontSize: isMobile ? 22 : 'clamp(22px, 3vw, 28px)',
          fontWeight: 600,
          lineHeight: 1.35,
          color: 'var(--text-primary)',
          marginBottom: 14,
          letterSpacing: '-0.01em',
        }}>
          {article.title}
        </h1>

        {/* Meta */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: isMobile ? 10 : 16,
          marginBottom: 32,
          paddingBottom: 24,
          borderBottom: '1px solid var(--border-light)',
          flexWrap: isMobile ? 'wrap' : 'nowrap',
        }}>
          {article.author && (
            <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', fontWeight: 500 }}>
              {article.author}
            </span>
          )}
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {formatFullDate(article.pubDate)}
          </span>
          {/* Desktop-only actions */}
          {!isMobile && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={() => onToggleStar(article)}
                title={article.isStarred ? '取消收藏' : '收藏'}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: article.isStarred ? '#F5C518' : 'var(--text-tertiary)',
                  display: 'flex', alignItems: 'center', padding: 4, borderRadius: 5,
                  transition: 'color 0.15s',
                }}
                onMouseEnter={e => { if (!article.isStarred) e.currentTarget.style.color = '#F5C518'; }}
                onMouseLeave={e => { if (!article.isStarred) e.currentTarget.style.color = 'var(--text-tertiary)'; }}
              >
                <Star size={15} fill={article.isStarred ? '#F5C518' : 'none'} strokeWidth={1.5} />
              </button>

              {article.link && !fullContent && (
                <button
                  onClick={handleFetchFull}
                  title="从原始网页提取全文"
                  style={{
                    fontSize: 12, color: 'var(--text-tertiary)',
                    background: 'none', border: '1px solid var(--border)',
                    borderRadius: 5, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '3px 8px', transition: 'color 0.15s, border-color 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-tertiary)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
                >
                  <AlignLeft size={11} />
                  加载全文
                </button>
              )}
              {fullContent === 'loading' && (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 11, height: 11, border: '1.5px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite' }} />
                  加载中…
                </span>
              )}
              {fullContent?.html && (
                <button
                  onClick={() => setFullContent(null)}
                  title="恢复 RSS 原文"
                  style={{
                    fontSize: 12, color: 'var(--accent)',
                    background: 'none', border: '1px solid var(--accent)',
                    borderRadius: 5, cursor: 'pointer',
                    padding: '3px 8px', opacity: 0.7, transition: 'opacity 0.15s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.opacity = 1}
                  onMouseLeave={e => e.currentTarget.style.opacity = 0.7}
                >
                  全文模式
                </button>
              )}
              {article.link && (
                <a
                  href={article.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 12, color: 'var(--accent)',
                    textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4,
                    opacity: 0.8, transition: 'opacity 0.15s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.opacity = 1}
                  onMouseLeave={e => e.currentTarget.style.opacity = 0.8}
                >
                  原文
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                    <path d="M2 10L10 2M10 2H5M10 2v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </a>
              )}
            </div>
          )}
          {/* Mobile: load full content button */}
          {isMobile && article.link && !fullContent && (
            <button
              onClick={handleFetchFull}
              style={{
                fontSize: 12, color: 'var(--text-tertiary)',
                background: 'none', border: '1px solid var(--border)',
                borderRadius: 5, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '3px 8px',
              }}
            >
              <AlignLeft size={11} />
              加载全文
            </button>
          )}
          {isMobile && fullContent === 'loading' && (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 11, height: 11, border: '1.5px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite' }} />
              加载中…
            </span>
          )}
          {isMobile && fullContent?.html && (
            <button
              onClick={() => setFullContent(null)}
              style={{
                fontSize: 12, color: 'var(--accent)',
                background: 'none', border: '1px solid var(--accent)',
                borderRadius: 5, cursor: 'pointer',
                padding: '3px 8px',
              }}
            >
              全文模式
            </button>
          )}
        </div>

        {/* Podcast play button */}
        {article.audioUrl && (
          <div style={{
            marginBottom: 32,
            padding: '12px 16px',
            background: 'var(--bg-panel)',
            borderRadius: 8,
            border: '1px solid var(--border-light)',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <Mic size={13} strokeWidth={2} style={{ color: 'var(--accent-light)', flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 500 }}>
              播客{article.audioDuration ? ` · ${article.audioDuration}` : ''}
            </span>
            <button
              onClick={() => onPlay(article)}
              style={{
                marginLeft: 'auto',
                display: 'flex', alignItems: 'center', gap: 5,
                fontSize: 12, fontWeight: 500, color: 'var(--accent)',
                padding: '4px 10px', borderRadius: 5,
                border: '1px solid var(--accent)',
                background: 'none', cursor: 'pointer',
                transition: 'background 0.12s',
                flexShrink: 0,
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}
            >
              {currentEpisode?.id === article.id && isPlaying
                ? <><Pause size={11} strokeWidth={2} /> 暂停</>
                : currentEpisode?.id === article.id
                  ? <><Play size={11} strokeWidth={2} /> 继续</>
                  : <><Play size={11} strokeWidth={2} /> 播放</>
              }
            </button>
          </div>
        )}

        {/* Content */}
        {fullContent?.error ? (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '20px 0' }}>
            加载失败：{fullContent.error}。
            <button onClick={() => setFullContent(null)} style={{ marginLeft: 8, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>重置</button>
          </div>
        ) : hasHtml ? (
          <div
            className="rss-article"
            style={articleContentStyle}
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(rawContent) }}
          />
        ) : (
          <div className="rss-article" style={articleContentStyle}>
            {rawContent.split('\n').filter(Boolean).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function sanitizeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/on\w+='[^']*'/gi, '');
}

const articleContentStyle = {
  fontFamily: 'var(--font-serif)',
  fontSize: 16,
  lineHeight: 1.85,
  color: 'var(--text-primary)',
};

if (typeof document !== 'undefined') {
  const id = 'rss-article-styles';
  if (!document.getElementById(id)) {
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      .rss-article p { margin-bottom: 1.1em; }
      .rss-article h1, .rss-article h2, .rss-article h3 {
        font-family: var(--font-serif);
        font-weight: 600;
        margin-top: 1.6em;
        margin-bottom: 0.6em;
        line-height: 1.3;
        color: var(--text-primary);
      }
      .rss-article h1 { font-size: 1.4em; }
      .rss-article h2 { font-size: 1.2em; }
      .rss-article h3 { font-size: 1.05em; }
      .rss-article a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
      .rss-article img { max-width: 100%; height: auto; border-radius: 6px; margin: 1em 0; }
      .rss-article blockquote {
        border-left: 3px solid var(--accent);
        margin: 1.2em 0;
        padding: 0.4em 0 0.4em 1.2em;
        color: var(--text-secondary);
        font-style: italic;
      }
      .rss-article pre, .rss-article code {
        font-family: 'SF Mono', 'Fira Mono', monospace;
        font-size: 0.88em;
        background: var(--bg-panel);
        border-radius: 4px;
      }
      .rss-article pre { padding: 1em; overflow-x: auto; margin: 1em 0; }
      .rss-article code { padding: 0.1em 0.3em; }
      .rss-article ul, .rss-article ol { padding-left: 1.4em; margin: 0.8em 0; }
      .rss-article li { margin-bottom: 0.3em; }
      .rss-article figure { margin: 1.2em 0; }
      .rss-article figcaption { font-size: 0.85em; color: var(--text-tertiary); text-align: center; margin-top: 4px; }
    `;
    document.head.appendChild(style);
  }
}
