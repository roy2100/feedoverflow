# RSS Reader

A self-hosted, full-stack RSS reader with a clean reading-first UI, full-text article
extraction, a podcast player, and a built-in **MCP server** that lets an LLM (Claude,
etc.) read and manage your feeds as tools — including summarizing the article you're
currently reading.

TypeScript end to end. React + PWA client, Express + SQLite backend, no build step on
the server (runs `.ts` directly on Node 24's native type-stripping).

> **Live demo:** _add your deployed URL here_
> **Screenshot:** _add `docs/screenshot.png` and it renders below_

<!-- ![RSS Reader](docs/screenshot.png) -->

---

## Highlights

- **Reading-first UI** — three-pane feed / list / reader layout on desktop, with a
  mobile-adapted PWA (installable, offline shell, parallax panel transitions).
- **No read/unread state — by design** — deliberately drops unread counts and
  "mark as read" mechanics, so there's no inbox-zero guilt. Browse by recency and
  star what's worth keeping instead.
- **Text-only mode (无图模式)** — a toggle that strips images, video, iframes and
  embeds from the article body for distraction-free reading; the preference persists.
- **RSSHub support** — subscribe with short `rsshub://path` URLs (e.g.
  `rsshub://anthropic/research`) that resolve at fetch time to your own RSSHub instance,
  configurable in Settings (default `http://localhost:1200`).
- **Full-text extraction** — when a feed only ships a truncated summary, fetch the
  original page and extract clean readable content with Mozilla Readability.
- **Podcast support** — feeds with audio enclosures get an inline player.
- **Full-text search** with feed-scoped filtering.
- **OPML import** — migrate your subscriptions from any other reader.
- **Durable archive** — every fetched article is persisted for search/research; a
  size-capped maintenance pass prunes the oldest non-starred items automatically.
- **Optional auth** — cookie-session basic auth gates non-localhost access, so the same
  binary runs fully-private on localhost or publicly behind a Cloudflare Tunnel.

## AI / MCP integration

The server exposes a [Model Context Protocol](https://modelcontextprotocol.io) endpoint
(Streamable HTTP transport) with **13 tools**, so an MCP-capable client can drive the
reader conversationally:

| Area | Tools |
|------|-------|
| Feeds | `list_feeds`, `add_feed`, `rename_feed`, `delete_feed`, `import_opml` |
| Reading | `get_all_articles`, `get_today_articles`, `get_feed_articles`, `get_starred_articles`, `get_starred_count` |
| State | `toggle_star`, `get_current_article` |
| Content | `fetch_article_content` |

Each tool is a thin wrapper over the same HTTP API the web UI uses, so the AI surface and
the UI can never drift apart. The standout is **`get_current_article`** — it reads the
article open in the browser UI, so you can ask *"summarize what I'm reading"* or *"star
this and find related posts"* and have it just work.

## Architecture

```
client/   React 19 + TypeScript + Vite + Zustand + react-router, PWA
server/    Express + better-sqlite3 (synchronous SQLite), TypeScript run directly on Node 24
           ├─ poller        scheduled feed fetch + persist
           ├─ content       Mozilla Readability full-text extraction
           ├─ favicon       fetched + cached per feed
           ├─ maintenance   DB size cap / old-article pruning
           └─ mcp           Streamable-HTTP MCP server (wraps the HTTP API)
```

- **No backend build step.** The server runs `.ts` files directly via Node 24's native
  TypeScript type-stripping — `node index.ts`, no bundler, no `tsc` emit.
- **One source of truth.** MCP tools call the HTTP API over loopback rather than
  re-implementing logic, keeping the AI and UI behaviors identical.
- Tested on both ends (`node:test` for the server, Vitest for the client); linted and
  formatted with [oxlint / oxfmt](https://oxc.rs).

## Getting started

Requires **Node ≥ 24**.

```bash
# install (root + server + client)
npm install && cd server && npm install && cd ../client && npm install && cd ..

# run server (:3002) + client (:3000) together
npm run dev
```

Open http://localhost:3000, then add a feed URL or import an OPML file.

To enable the MCP endpoint for a client like Claude Desktop, point it at
`http://localhost:3002/mcp` (Streamable HTTP transport).

### Auth (optional)

Copy `server/.env.example` to `server/.env` and set `AUTH_USER` / `AUTH_PASS` to require
login for non-localhost requests (e.g. when exposing the reader over a Cloudflare Tunnel).
Leave them empty for localhost-only private use.

## Tech stack

**Frontend:** React 19, TypeScript, Vite, Zustand, react-router, vite-plugin-pwa
**Backend:** Node 24, Express, better-sqlite3, Mozilla Readability, rss-parser, zod
**AI:** `@modelcontextprotocol/sdk` (Streamable HTTP)
**Tooling:** oxlint, oxfmt, node:test, Vitest

## License

MIT — see [LICENSE](LICENSE).
