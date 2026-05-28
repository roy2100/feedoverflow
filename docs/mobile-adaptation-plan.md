# 移动端适配计划

## 目标

让应用在手机浏览器（iOS Safari / Android Chrome）上可用。采用三页式导航：
**订阅源 → 文章列表 → 文章阅读**，点击切换，支持返回和手势滑动。

桌面端（≥ 768px）保持现有三栏布局，完全不受影响。

---

## 技术选型

### React Router v6

用于管理三个页面的路由，移动端和桌面端共用同一套路由，桌面端渲染时忽略 URL 变化（固定显示三栏）。

路由结构（移动端实际导航）：

```
/                →  FeedSidebar（订阅源列表）
/list            →  ArticleList（文章列表，需携带 selectedView）
/article/:id     →  ArticleReader（文章阅读）
```

桌面端：始终渲染三栏，Router 仅作为状态同步工具，不控制布局。

### 状态管理：Zustand

将 `App.jsx` 中的全局状态迁移到 Zustand store，解决跨页面（跨路由）共享状态的问题。否则从 `/list` 导航到 `/article/:id` 时，selectedView、articles、selectedArticle 等状态会丢失。

**store 结构：**

```js
// src/store.js
{
  // 数据
  feeds: [],
  articles: [],
  selectedView: { type: 'today' },
  selectedArticle: null,
  starredCount: 0,
  loadingArticles: false,

  // 播客
  currentEpisode: null,
  isPlaying: false,

  // actions
  setFeeds, loadArticles, selectView, selectArticle,
  toggleStar, addFeed, deleteFeed, updateFeed,
  setCurrentEpisode, togglePlay, closePlayer,
}
```

`audioRef` 仍留在组件内（不可序列化，不放 store）。

---

## 路由与布局策略

### 移动端路由

```
/ (FeedSidebar)
  ↓ 点击 view
/list (ArticleList)
  ↓ 点击文章
/article/:id (ArticleReader)
  ↑ 返回
```

每页顶部有 header，包含：
- `←` 返回按钮（list 页返回 `/`，reader 页返回 `/list`）
- 页面标题
- 右侧操作按钮（添加订阅、刷新等）

### 桌面端布局

保持 `display: flex` 三栏，不受路由影响。路由渲染出 `<Outlet>` 但桌面端直接渲染三个组件，无需 Outlet。

实现方式：`App.jsx` 根据 `isMobile` 分支：
- `isMobile = false`：渲染现有三栏 JSX（组件从 store 取数据，不再传 props）
- `isMobile = true`：渲染 `<Routes>` 三个路由页面

---

## 重构内容

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/store.js` | Zustand store，替代 App.jsx 的 useState 逻辑 |
| `src/hooks/useIsMobile.js` | `window.innerWidth ≤ 768` + resize 监听 |
| `src/pages/FeedsPage.jsx` | 移动端订阅源页（包裹 FeedSidebar + 移动端 header） |
| `src/pages/ListPage.jsx` | 移动端文章列表页（包裹 ArticleList + 返回按钮） |
| `src/pages/ReaderPage.jsx` | 移动端阅读页（包裹 ArticleReader + 返回按钮） |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `src/main.jsx` | 包裹 `<BrowserRouter>` |
| `src/App.jsx` | 状态逻辑迁移到 store；根据 isMobile 渲染桌面三栏或移动端路由 |
| 各组件 | props 改从 store 取（或保留 props，由页面组件传入） |
| `src/index.css` | 添加移动端滚动修复、safe-area-inset 支持 |

### 组件 props 策略

各面板组件（FeedSidebar、ArticleList、ArticleReader）**保留 props 接口不变**，由各自的 Page 组件从 store 取数据后传入。这样组件本身无需改动，Page 组件承担"连接 store"的职责，类似 container 模式。

---

## 移动端页面 Header 设计

```
FeedsPage header:
  [ 订阅源 ]  ..................  [ 刷新 ] [ + ]

ListPage header:
  [ ← ]  [ 今日 / 全部未读 / Feed名 ]  [ 刷新 ]

ReaderPage header:
  [ ← ]  [ 文章标题（截断） ]  [ ★ ]
```

---

## 暂时去掉的功能（移动端）

| 功能 | 原因 |
|------|------|
| Settings 入口 | 移动端使用频率低，暂不支持 |
| ManageFeedsModal 入口 | 管理操作在移动端交互复杂，暂不支持 |

保留：添加订阅（AddFeedModal）、收藏、标记已读、播客播放器。

---

## 实现步骤

1. **安装依赖**：`react-router-dom`、`zustand`
2. **建 store**：`src/store.js`，迁移 App.jsx 全部状态和 action
3. **改 App.jsx**：接入 store，根据 isMobile 渲染桌面三栏（验证桌面端不变）
4. **建移动端页面**：FeedsPage、ListPage、ReaderPage
5. **接入路由**：main.jsx 加 BrowserRouter，App.jsx 移动端路径渲染 Routes
6. **CSS 补充**：mobile safe area、滚动行为
7. **手势滑动**：`transform: translateX` + touch 事件，或使用 `react-swipeable`
8. **验证**：DevTools 移动端模拟 + 真机测试

---

## 不做的事

- 不改变 API 层
- 不拆分 CSS 变量
- 不改变桌面端布局和行为
