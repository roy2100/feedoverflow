# 播客后台播放计划

## 现状

服务端已解析 RSS enclosure，将 `audio_url` / `audio_duration` 存入 SQLite，API 已返回这两个字段。  
前端：ArticleList 对播客条目显示 Mic 徽章，ArticleReader 内嵌一个原生 `<audio controls>`。  
**问题**：audio 元素随 ArticleReader 重渲染而销毁，切换文章即停止播放。

---

## 目标

在不增加心智负担的前提下，实现切换文章/视图时音频持续播放。  
设计原则：**最小改动、零依赖、不新增路由**。

---

## 方案概述

将播放状态提升到 `App.jsx`，新增一个持久化的底部迷你播放条 `PodcastPlayer`，  
用一个常驻的 `<audio>` 元素（通过 `useRef` 持有）驱动全局播放。

```
App.jsx
 ├─ currentEpisode (article | null)   ← 当前播放集
 ├─ audioRef (useRef<HTMLAudioElement>)
 └─ PodcastPlayer  ← 底部悬浮条，仅当 currentEpisode 非 null 时渲染
      ArticleReader  ← 移除内嵌 <audio>，改为"播放"按钮调 onPlay
      ArticleList    ← 列表行已有 Mic 徽章，加一个点击直接播放的交互
```

---

## 改动清单

### 1. `App.jsx`

- 新增状态：
  ```js
  const [currentEpisode, setCurrentEpisode] = useState(null);
  const audioRef = useRef(new Audio());
  ```
- 新增回调 `handlePlay(article)`：
  - 如果 `article.id === currentEpisode?.id`：切换 play/pause
  - 否则：更换 `audioRef.current.src`，记录 `currentEpisode`，自动播放
- 下传 `onPlay={handlePlay}` 给 `ArticleReader`、`ArticleList`
- 渲染 `<PodcastPlayer>` 在三列布局之外（布局底部）

### 2. 新建 `PodcastPlayer.jsx`

| 区域 | 内容 |
|------|------|
| 左   | 集标题（截断）+ 来源 feed 名 |
| 中   | ⏮ -15s · ▶/⏸ · ⏭ +15s + 进度条（可拖动） |
| 右   | 倍速切换（1× / 1.5× / 2×）+ ✕ 关闭 |

Props：`{ episode, audioRef, onClose }`  
内部用 `useEffect` 监听 `timeupdate` / `loadedmetadata` 更新进度显示。  
进度条用 `<input type="range">` 拖动跳转。

### 3. `ArticleReader.jsx`

- 删除现有 `<audio controls>` 块
- 改为一个"▶ 播放"按钮，点击调 `onPlay(article)`
- 正在播放时按钮显示"⏸ 暂停"（通过 `currentEpisode?.id === article.id && isPlaying` 判断）

### 4. `ArticleList.jsx`

- 现有 Mic 徽章改为可点击，调 `onPlay(article)`（无需打开阅读器）

---

## 不改动的部分

- 服务端：无需任何变更，字段已就位
- 数据库：无需新增列
- 路由 / 视图逻辑：无变更
- CSS 变量：复用现有 `--bg-panel`、`--border`、`--accent` 等

---

## 布局影响

底部播放条固定高度 **56px**，`position: fixed; bottom: 0`。  
三列主容器加 `paddingBottom: 56px`（仅当 `currentEpisode` 非 null 时）避免内容被遮挡。

---

## 实现顺序

1. `App.jsx` —— 添加 `currentEpisode`、`audioRef`、`handlePlay`
2. `PodcastPlayer.jsx` —— 新建组件，接入 audioRef
3. `ArticleReader.jsx` —— 替换内嵌 audio
4. `ArticleList.jsx` —— Mic 徽章加 onPlay
5. 手工验证：播放 → 切换文章 → 音频继续；关闭播放条；倍速切换

---

## 工作量估计

约 150–200 行新增/修改代码，无新依赖，预计 1–2 小时完成。
