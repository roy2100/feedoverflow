<p align="center">
  <img src="client/public/pwa-512x512.png" alt="FeedOverflow 标志" width="112" />
</p>

<h1 align="center">FeedOverflow</h1>

<p align="center">一个以阅读为先的自托管 RSS 阅读器。</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

一个自托管的全栈 RSS 阅读器，界面简洁、以阅读体验为核心，内置全文提取和播客播放器。
它还内置了一个 **MCP 服务器**，让 LLM（Claude 等）能以工具的形式读取和管理你的订阅
——包括总结你正在阅读的这篇文章。

前端是 React + PWA 客户端（TypeScript），后端是单二进制的 **Go 服务**（`server-go/`），
基于 SQLite，同时提供 API 和静态客户端资源。

> **在线演示：** <https://demo.royl.uk:8443> — 公开体验实例，示例数据，每 6 小时重置一次。

<table>
<tr>
<td><img src="docs/images/screenshot-desktop.png" alt="桌面端：订阅 / 列表 / 阅读三栏布局" width="600"></td>
<td><img src="docs/images/screenshot-mobile.png" alt="移动端：单栏阅读视图" width="180"></td>
</tr>
</table>

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

## 配置项

所有配置都是环境变量，且**全部可选**——不设任何环境变量也能跑起来，监听 `:3002`、
使用 `./rss.db`。只有 `AUTH_USER`/`AUTH_PASS` 在你把应用暴露到本机以外时才变成实际
必需的。

属于**内容**而非部署的运行时设置（RSSHub 地址、逐源推送开关）在应用的设置界面和
数据库里，不在这里。

| 变量 | 默认值 | 作用 |
|---|---|---|
| `PORT` | `3002` | 公开监听端口，绑定所有网卡。设置了 `AUTH_USER`/`AUTH_PASS` 时受鉴权保护。 |
| `LOCAL_API_PORT` | `4002` | 仅本地回环（`127.0.0.1`）的伴随监听，永不鉴权、永不对外暴露。MCP 端点 `/mcp` 也挂在它上面。 |
| `AUTH_USER` | *(空)* | 登录用户名。**必须与 `AUTH_PASS` 同时设置**才能保护公开监听；任一为空即等于完全关闭鉴权。 |
| `AUTH_PASS` | *(空)* | 登录密码。同上——只配一半等于没配。 |
| `RSS_DB` | `rss.db` | SQLite 文件路径。文件不存在会自动创建，但父目录必须已存在。 |
| `DB_MAX_SIZE_MB` | `2048` | 体积上限。超过后维护任务会裁掉最旧的**非星标**文章到 90% 并 `VACUUM`。星标文章永不删除。 |
| `REFRESH_CONCURRENCY` | `6` | 同时进行的抓取+持久化链条数上限——它是所有抓取路径（轮询扇出、启动预热、按需读取）唯一的节流阀。 |
| `LOG_DIR` | *(空)* | NDJSON 日志（`app.log`，自动轮转）的目录。留空则输出到 stderr。目录必须已存在。 |
| `CLIENT_DIST` | `client/dist` | 公开监听所服务的客户端构建产物。留空则不提供静态文件（纯 API）。 |
| `PUSH_SUBJECT` | `https://rss.royl.uk` | Web Push 的 VAPID `sub` 声明——它是给推送服务运维方的联系标识，不是任何人会去连接的端点。任何合法的 `https:` URL 或 `mailto:` 都可以，不需要与你的 origin 一致。 |
| `RSS_ENV_FILE` | *(未设置)* | 一个 `KEY=VALUE` 文件的路径，会在读取其余配置之前加载。见下。 |
| `RSS_DISABLE_JOBS` | *(未设置)* | 任何非空值都会跳过**全部**后台任务——轮询、维护、WAL checkpoint、缓存预热。用于测试和契约比对，不要用于生产。 |

### 怎么设置

**直接设置**，适合临时运行：

```bash
AUTH_USER=me AUTH_PASS=secret npm run server
```

**用 env 文件**，适合长期安装。`RSS_ENV_FILE` 本身必须来自真实环境变量——它指明文件
在哪，所以不能写在这个文件里面：

```bash
RSS_ENV_FILE=/path/to/.env npm run server
```

环境里已存在的值**优先于文件**——文件只负责补空缺，不会覆盖。这样你可以用一个 shell
变量或 systemd/launchd 的 `Environment=` 覆盖单个配置，而不必改文件。

**用 Docker** 时通过 `.env` 设置（见下方"用 Docker 运行"）。`PORT`、`LOCAL_API_PORT`、
`RSS_DB`、`LOG_DIR`、`CLIENT_DIST` 在镜像里已经指向容器内的合适路径，除非你清楚自己
在做什么，否则不要覆盖。

### 客户端构建期变量

客户端是静态产物，所以它的变量由 Vite 在**构建时**读取并内联进产物；运行时再设置没有
任何效果。

| 变量 | 作用 |
|---|---|
| `VITE_DEMO_MODE` | 非空则渲染公开演示实例的横幅。普通构建下是空操作。 |

## 用 Docker 运行

无需安装 Go/Node 工具链，只要 Docker。镜像是多阶段构建（客户端 + cgo Go 二进制），
SQLite 数据库和日志持久化在命名卷上。

```bash
cp .env.example .env        # 可选：设置 AUTH_USER/AUTH_PASS 及调优项
docker compose up -d        # 在 http://localhost:3002 提供服务
```

若要使用 `rsshub://` 订阅源，可一并启动内置的 RSSHub（只用普通 RSS 则无需启动）：

```bash
docker compose --profile rsshub up -d
```

然后在设置里把 **rsshub_base_url** 设为 `http://rsshub:1200`。数据保存在 `rss-data`
卷上；请做好备份（或 `docker compose down` 时**不要**加 `-v`），以保留文章和收藏。

## 技术栈

- **前端：** React 19, TypeScript, Vite, Zustand, react-router, vite-plugin-pwa
- **后端：** Go 1.26, chi, mattn/go-sqlite3, go-readability, gofeed, lumberjack
- **AI：** Model Context Protocol（Streamable HTTP），基于 `modelcontextprotocol/go-sdk`
- **工具链：** go test + staticcheck（服务端），oxlint + oxfmt + Vitest（客户端）

## 许可证

AGPL-3.0 —— 见 [LICENSE](LICENSE)。若以网络服务形式运行修改版，须向用户提供其源码。
