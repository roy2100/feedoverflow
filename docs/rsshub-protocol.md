# RSSHub 协议支持方案

## 目标

用户在添加订阅时可以输入 `rsshub://` 前缀的短地址，后台自动替换为本地 RSSHub 实例的完整 URL。

```
rsshub://anthropic/research
  → http://localhost:1200/anthropic/research
```

RSSHub 实例地址可在设置中配置，默认为 `http://localhost:1200`。

---

## 设计决策

**在数据库里存 `rsshub://` 原始地址，在抓取时动态解析。**

好处：
- 修改 RSSHub 实例地址后，所有订阅源自动生效，无需逐条更新
- URL 意图清晰，一眼看出哪些来自 RSSHub

---

## 改动范围

### 1. `server/index.js`

#### 1a. 新增 `settings` 表

```sql
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

启动时写入默认值（仅在不存在时）：

```js
db.prepare(`
  INSERT OR IGNORE INTO settings (key, value)
  VALUES ('rsshub_base_url', 'http://localhost:1200')
`).run();
```

#### 1b. 新增 `resolveUrl(url)` 工具函数

```js
function resolveUrl(url) {
  if (!url.startsWith('rsshub://')) return url;
  const base = db.prepare("SELECT value FROM settings WHERE key='rsshub_base_url'").get()?.value
    || 'http://localhost:1200';
  return base.replace(/\/$/, '') + '/' + url.slice('rsshub://'.length);
}
```

调用位置：
- `parseURL(url)` 入口处：`url = resolveUrl(url)`
- `fetchAndCache(feed)` 中：`parseURL(resolveUrl(feed.url))`
- `getCachedFeed(feed)` 中：`parseURL(resolveUrl(feed.url), signal)`

> 注意：`POST /api/feeds` 保存的是原始 `rsshub://` URL，不做替换。

#### 1c. 新增 Settings API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/settings` | 返回所有设置项 `{ rsshub_base_url: "..." }` |
| PATCH | `/api/settings` | 更新设置项，支持传 `{ rsshub_base_url: "..." }` |

PATCH 后使 feedCache 失效（`feedCache.clear()`），强制下次重新抓取。

---

### 2. `client/src/components/AddFeedModal.jsx`

在 URL 输入框下方添加提示文字（仅当输入内容以 `rsshub://` 开头时显示，或常驻显示小提示）：

```
💡 支持 rsshub://路由/路径 格式，自动连接本地 RSSHub 实例
```

当用户输入 `rsshub://` 开头时，输入框下方实时预览解析后的完整 URL：

```
→ http://localhost:1200/路由/路径
```

---

### 3. `client/src/components/SettingsModal.jsx`（新建）

在侧边栏底部增加「设置」入口（齿轮图标），点击弹出设置 Modal。

初期只有一个配置项：

```
RSSHub 实例地址
[ http://localhost:1200          ] [保存]
```

保存后调用 `PATCH /api/settings`，并提示「已保存，订阅将使用新地址抓取」。

---

### 4. `client/src/components/FeedSidebar.jsx`

底部工具栏增加齿轮按钮，点击触发 `onOpenSettings` 回调。

---

### 5. `client/src/App.jsx`

- 新增 `settingsOpen` state
- 传递 `onOpenSettings` 给 `FeedSidebar`
- 渲染 `<SettingsModal>` 

---

## 文件变动汇总

| 文件 | 操作 | 说明 |
|------|------|------|
| `server/index.js` | 修改 | 新增 settings 表、resolveUrl、Settings API |
| `client/src/components/AddFeedModal.jsx` | 修改 | rsshub:// 提示 + 实时预览 |
| `client/src/components/SettingsModal.jsx` | 新建 | RSSHub 实例地址配置 |
| `client/src/components/FeedSidebar.jsx` | 修改 | 底部新增齿轮按钮 |
| `client/src/App.jsx` | 修改 | settingsOpen state + SettingsModal 渲染 |

---

## 实现顺序

1. `server/index.js` — settings 表 + resolveUrl + API（核心，无依赖）
2. `AddFeedModal.jsx` — rsshub:// 提示与预览（独立，可单独测试）
3. `SettingsModal.jsx` — 新建设置面板
4. `FeedSidebar.jsx` + `App.jsx` — 接入设置入口

---

## 不在本次范围内

- rsshub:// 路由的自动补全 / 搜索
- RSSHub 实例健康检查（连接失败时的提示）
- 多 RSSHub 实例支持
