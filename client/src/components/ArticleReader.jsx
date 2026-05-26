function formatFullDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function ArticleReader({ article }) {
  if (!article) {
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

  const rawContent = article.content || article.summary || '';

  const hasHtml = /<[a-z][\s\S]*>/i.test(rawContent);

  return (
    <div
      key={article.id}
      style={{
        flex: 1,
        background: 'var(--bg-reader)',
        overflowY: 'auto',
        animation: 'fadeIn 0.2s ease',
      }}
    >
      <div style={{
        maxWidth: 680,
        margin: '0 auto',
        padding: '48px 48px 80px',
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
          fontSize: 'clamp(22px, 3vw, 28px)',
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
          gap: 16,
          marginBottom: 32,
          paddingBottom: 24,
          borderBottom: '1px solid var(--border-light)',
        }}>
          {article.author && (
            <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', fontWeight: 500 }}>
              {article.author}
            </span>
          )}
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {formatFullDate(article.pubDate)}
          </span>
          {article.link && (
            <a
              href={article.link}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                marginLeft: 'auto',
                fontSize: 12,
                color: 'var(--accent)',
                textDecoration: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                opacity: 0.8,
                transition: 'opacity 0.15s',
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

        {/* Content */}
        {hasHtml ? (
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

// Very basic sanitization — strip scripts/iframes but keep formatting
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
  // Paragraph spacing via CSS applied in-line for React
};

// Injected article styles via a <style> tag approach would be cleaner,
// but we can use a global style block trick:
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

