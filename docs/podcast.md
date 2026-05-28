# 播客直接收听功能

## Context

为 RSS 阅读器添加播客收听功能，以 `https://anchor.fm/s/1030dc984/podcast/rss` 为测试源。播客 RSS feed 使用标准 `<enclosure>` 标签携带音频 URL，以及 iTunes 命名空间的 `<itunes:duration>`。目标是在阅读器中直接展示 HTML5 音频播放器，无需跳转外部应用。

## 方案

三处改动，不引入新依赖，不改动数据库结构。

---

### 1. `server/index.js`

**在 `enrich()` 函数之前添加辅助函数**（第 86 行之前）：

```js
function normalizeDuration(dur) {
  if (!dur) return '';
  if (/^\d+:\d{2}(:\d{2})?$/.test(dur)) return dur;  // 已是 MM:SS / HH:MM:SS
  const secs = parseInt(dur, 10);
  if (isNaN(secs)) return dur;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}
```

**在 `enrich()` 返回对象中增加两个字段**（`author` 字段之后）：

```js
// 播客字段
const enc = item.enclosure;
const audioUrl = (enc?.url && enc?.type?.startsWith('audio')) ? enc.url : '';
const audioDuration = audioUrl ? normalizeDuration(item.itunes?.duration || '') : '';

return {
  ...
  author: ...,
  audioUrl,
  audioDuration,
  isRead: ...,
  isStarred: ...,
};
```

> `rss-parser` 已自动解析 `item.enclosure` 和 `item.itunes.duration`，无需修改 `makeParser()`。

---

### 2. `client/src/components/ArticleList.jsx`

**修改 import**（第 2 行）：
```jsx
import { Star, Mic } from 'lucide-react';
```

**修改 `ArticleItem` 底部信息行**（第 105–112 行），将 summary span 改为条件渲染：

```jsx
<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
  {article.audioUrl ? (
    <span style={{
      display: 'flex', alignItems: 'center', gap: 3,
      fontSize: 11, color: 'var(--accent-light)', fontWeight: 500,
    }}>
      <Mic size={10} strokeWidth={2} />
      {article.audioDuration || '播客'}
    </span>
  ) : (
    <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {summary}
    </span>
  )}
  <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0, marginLeft: 'auto' }}>
    {formatDate(article.pubDate)}
  </span>
</div>
```

---

### 3. `client/src/components/ArticleReader.jsx`

**修改 import**（第 2 行）：
```jsx
import { Star, AlignLeft, Mic } from 'lucide-react';
```

**在 Meta div 之后（第 190 行）、Content 注释之前（第 192 行）插入播放器**：

```jsx
{/* Podcast Player */}
{article.audioUrl && (
  <div style={{
    marginBottom: 32,
    padding: '14px 16px',
    background: 'var(--bg-panel)',
    borderRadius: 8,
    border: '1px solid var(--border-light)',
  }}>
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      marginBottom: 10, fontSize: 12,
      color: 'var(--text-tertiary)', fontWeight: 500,
    }}>
      <Mic size={13} strokeWidth={2} style={{ color: 'var(--accent-light)' }} />
      <span>收听播客</span>
      {article.audioDuration && (
        <span style={{ marginLeft: 4 }}>· {article.audioDuration}</span>
      )}
    </div>
    <audio
      controls
      src={article.audioUrl}
      style={{ width: '100%', height: 36, outline: 'none' }}
      preload="none"
    >
      您的浏览器不支持 audio 元素。
    </audio>
  </div>
)}
```

---

## 边界情况

| 情形 | 结果 |
|------|------|
| 普通文章（无 enclosure） | `audioUrl = ''`，播放器和标识均不渲染 |
| 非音频 enclosure（如 image/jpeg） | `type.startsWith('audio')` 为 false，`audioUrl = ''` |
| 有 enclosure 无 duration | 列表显示 "播客"，阅读器标题行不显示时长 |
| 收藏视图中的播客文章 | `starred` API 从 `article_states` 读取（无 audioUrl 列），不显示播放器；可接受的限制 |

---

## 验证

1. 添加播客源：`https://anchor.fm/s/1030dc984/podcast/rss`
2. 打开播客文章 → ArticleList 中应显示麦克风图标 + 时长（如 `42:30`）
3. 点击文章 → ArticleReader 中标题下方出现播放器卡片
4. 点击播放按钮 → 音频开始加载播放
5. 普通 RSS 文章（如少数派/36氪）→ 列表无图标，阅读器无播放器
