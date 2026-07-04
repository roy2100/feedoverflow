# RSS Reader

[English](README.md) | **简体中文**

一个自托管的全栈 RSS 阅读器，界面简洁、以阅读体验为核心，内置全文提取和播客播放器。
它还内置了一个 **MCP 服务器**，让 LLM（Claude 等）能以工具的形式读取和管理你的订阅
——包括总结你正在阅读的这篇文章。

前端是 React + PWA 客户端（TypeScript），后端是单二进制的 **Go 服务**（`server-go/`），
基于 SQLite，同时提供 API 和静态客户端资源。

> **在线演示：** _在这里填上你的部署地址_

<p>
  <img src="docs/images/screenshot-desktop.png" alt="桌面端：订阅 / 列表 / 阅读三栏布局" width="700">
  <img src="docs/images/screenshot-mobile.png" alt="移动端：单栏阅读视图" width="200">
</p>

---

## 特性

- **以阅读为先的 UI** —— 桌面端为订阅 / 列表 / 阅读三栏布局，移动端做了适配的 PWA
  （可安装、离线 shell、面板视差过渡动画）。
- **没有已读/未读状态——这是有意为之** —— 刻意去掉未读计数和"标记已读"机制，不
  制造 inbox-zero 式的焦虑。按时间浏览，把值得留存的内容加星即可。
- **无图模式（Text-only mode）** —— 一键剥离文章正文中的图片、视频、iframe 和
  嵌入内容，专注阅读文字；该偏好会被记住。
- **RSSHub 支持** —— 用简短的 `rsshub://path` 形式订阅（例如
  `rsshub://anthropic/research`），拉取时解析到你自己的 RSSHub 实例，可在设置中
  配置（默认 `http://localhost:1200`）。
- **全文提取** —— 当订阅源只提供截断摘要时，抓取原始页面并用 Mozilla Readability
  提取干净的可读内容。
- **播客支持** —— 带音频 enclosure 的订阅会显示内嵌播放器。
- **全文搜索**，支持按订阅源过滤。
- **OPML 导入** —— 从其他阅读器一键迁移订阅列表。
- **持久归档** —— 每一篇抓取到的文章都会被持久化用于搜索/研究；一个带体积上限的
  维护任务会自动清理最旧的未加星文章。
- **可选鉴权** —— cookie session 形式的基础鉴权可以拦截非本地访问，同一个二进制
  既能在本地完全私有运行，也能通过 Cloudflare Tunnel 公开访问。

## AI / MCP 集成

Go 服务暴露了一个 [Model Context Protocol](https://modelcontextprotocol.io) 端点
（Streamable HTTP 传输），提供 **13 个工具**，挂载在仅监听本地回环、无需鉴权的
`/mcp`（`LOCAL_API_PORT`）上，让支持 MCP 的客户端可以用对话方式操作这个阅读器：

| 分类 | 工具 |
|------|------|
| 订阅源 | `list_feeds`, `add_feed`, `rename_feed`, `delete_feed`, `import_opml` |
| 阅读 | `get_all_articles`, `get_today_articles`, `get_feed_articles`, `get_starred_articles`, `get_starred_count` |
| 状态 | `toggle_star`, `get_current_article` |
| 内容 | `fetch_article_content` |

每个工具都只是对同一套 Web UI 所用 HTTP API 的薄封装，所以 AI 能力和 UI 行为永远
不会出现差异。最值得一提的是 **`get_current_article`** —— 它读取的是浏览器 UI 中
当前打开的文章，所以你可以直接问"总结一下我正在看的这篇"或"给这篇加星并找相关
文章"，它就能直接生效。

## 架构

```
client/     React 19 + TypeScript + Vite + Zustand + react-router, PWA
server-go/  Go + go-sqlite3 (SQLite), chi router —— 单个编译产物
            ├─ jobs        定时抓取订阅源/持久化 + 维护任务
            ├─ content     go-readability 全文提取
            ├─ favicon     按订阅源抓取并缓存
            ├─ mcp         Model Context Protocol 服务器（13 个工具），仅本地回环
            └─ maintenance 数据库体积上限 / 清理旧文章
```

- **单二进制。** 后端编译为一个 cgo 二进制文件（`mattn/go-sqlite3`）；没有打包器，
  除了它自己管理的 SQLite 文件外没有其他运行时依赖。
- **单一数据源。** MCP 工具通过本地回环调用同一套 HTTP API，而不是重新实现一遍
  逻辑，从而保证 AI 能力和 UI 行为始终一致。
- 前后端都有测试覆盖（服务端用 `go test`，客户端用 Vitest）；服务端用 `staticcheck`
  做静态检查，客户端用 [oxlint / oxfmt](https://oxc.rs) 做 lint / 格式化。

## 快速开始

需要 **Go ≥ 1.26**（后端，需要 cgo）和 **Node ≥ 22**（客户端 + 工具链）。

```bash
# 安装客户端 + 根目录工具链依赖（Go 后端用 go modules —— 不需要 npm install）
npm install && cd client && npm install && cd ..

# 同时启动 Go 服务（:3002）和客户端（:3000）
npm run dev
```

打开 http://localhost:3000，添加一个订阅源 URL 或导入 OPML 文件。

仅监听本地回环、无需鉴权的伴生端口（`LOCAL_API_PORT`，默认 4002）同时也提供
`/mcp` 端点（见上方"AI / MCP 集成"一节）。

### 鉴权（可选）

设置 `AUTH_USER` / `AUTH_PASS`（可以是环境变量，也可以放在 `RSS_ENV_FILE` 指向的
env 文件里），即可要求每个请求都登录——用于把阅读器暴露在公网隧道上。留空则仅限
本地私有使用。

## 技术栈

- **前端：** React 19, TypeScript, Vite, Zustand, react-router, vite-plugin-pwa
- **后端：** Go 1.26, chi, mattn/go-sqlite3, go-readability, gofeed, lumberjack
- **AI：** Model Context Protocol（Streamable HTTP），基于 `modelcontextprotocol/go-sdk`
- **工具链：** go test + staticcheck（服务端），oxlint + oxfmt + Vitest（客户端）

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
