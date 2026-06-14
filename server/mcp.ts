import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';

import { isLocalhost } from './auth.ts';
import { PORT } from './config.ts';

// MCP tools reuse the HTTP API by calling it over loopback in this same process.
const BASE_URL = `http://localhost:${PORT}`;

async function request(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    ...(body !== undefined && {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${method} ${path}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

const get = (path: string) => request('GET', path);
const post = (path: string, body: unknown = {}) => request('POST', path, body);
const patch = (path: string, body: unknown = {}) => request('PATCH', path, body);
const del = (path: string) => request('DELETE', path);

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const articleFields = {
  id: z.string().describe('Article ID (12-char MD5 hash)'),
  feedId: z.string().describe('Feed ID the article belongs to'),
  feedName: z.string().describe('Display name of the feed'),
  title: z.string().describe('Article title'),
  link: z.string().describe('Article URL'),
  pubDate: z.string().describe('Publication date in ISO format'),
  summary: z.string().optional().default('').describe('Article summary/snippet'),
  content: z.string().optional().default('').describe('Full article HTML content'),
  author: z.string().optional().default('').describe('Article author'),
  isStarred: z.boolean().optional().default(false),
};

function buildServer(): McpServer {
  const server = new McpServer({ name: 'rss-reader', version: '1.0.0' });

  // --- Feeds ---

  server.registerTool(
    'list_feeds',
    { description: 'List all subscribed RSS feeds with their id, name, and URL.' },
    async () => text(await get('/api/feeds')),
  );

  server.registerTool(
    'add_feed',
    {
      description: 'Subscribe to a new RSS feed by URL.',
      inputSchema: {
        url: z.string().url().describe('RSS feed URL'),
        name: z.string().optional().describe('Display name; defaults to feed title if omitted'),
      },
    },
    async ({ url, name }) => text(await post('/api/feeds', { url, name })),
  );

  server.registerTool(
    'rename_feed',
    {
      description: 'Rename an existing feed.',
      inputSchema: {
        id: z.string().describe('Feed ID from list_feeds'),
        name: z.string().describe('New display name'),
      },
    },
    async ({ id, name }) => text(await patch(`/api/feeds/${encodeURIComponent(id)}`, { name })),
  );

  server.registerTool(
    'delete_feed',
    {
      description: 'Unsubscribe from a feed and remove it from the list.',
      inputSchema: { id: z.string().describe('Feed ID from list_feeds') },
    },
    async ({ id }) => text(await del(`/api/feeds/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    'import_opml',
    {
      description:
        'Bulk-import feeds from an OPML XML string. Returns count of imported and skipped feeds.',
      inputSchema: { opml: z.string().describe('OPML XML content as a string') },
    },
    async ({ opml }) => text(await post('/api/feeds/import-opml', { opml })),
  );

  // --- Articles ---

  server.registerTool(
    'get_all_articles',
    {
      description:
        'Get the latest articles across all feeds (up to 5 per feed), sorted by date descending.',
    },
    async () => text(await get('/api/all-articles')),
  );

  server.registerTool(
    'get_today_articles',
    { description: 'Get all articles published today across all feeds.' },
    async () => text(await get('/api/today')),
  );

  server.registerTool(
    'get_starred_articles',
    { description: 'Get all starred/bookmarked articles.' },
    async () => text(await get('/api/starred')),
  );

  server.registerTool(
    'get_feed_articles',
    {
      description: 'Get the latest articles (up to 50) from a specific feed.',
      inputSchema: { feed_id: z.string().describe('Feed ID from list_feeds') },
    },
    async ({ feed_id }) => text(await get(`/api/feeds/${encodeURIComponent(feed_id)}/articles`)),
  );

  server.registerTool(
    'get_starred_count',
    { description: 'Get the total count of starred articles.' },
    async () => text(await get('/api/starred/count')),
  );

  // --- Article state ---

  server.registerTool(
    'toggle_star',
    {
      description:
        'Star or unstar an article. Pass the full article object and the desired starred state.',
      inputSchema: {
        ...articleFields,
        starred: z.boolean().describe('true to star, false to unstar'),
      },
    },
    async ({ starred, ...article }) => text(await post('/api/articles/star', { article, starred })),
  );

  // --- Current article ---

  server.registerTool(
    'get_current_article',
    {
      description:
        "Get the article currently open in the RSS reader UI. Returns the full article object including title, link, summary, content, author, feed name, and starred state. Use this when the user says 'this article', 'the current article', or 'what I'm reading'.",
    },
    async () => text(await get('/api/current-article')),
  );

  // --- Content ---

  server.registerTool(
    'fetch_article_content',
    {
      description:
        'Fetch the full readable content of an article from its original URL using Mozilla Readability. Use when the article summary is truncated.',
      inputSchema: { url: z.string().url().describe('Article URL') },
    },
    async ({ url }) => text(await get(`/api/fetch-content?url=${encodeURIComponent(url)}`)),
  );

  return server;
}

/**
 * Mount the MCP server on the Express app using the Streamable HTTP transport.
 * Stateless: a fresh server + transport is created per request, so there is no
 * session state to track — fine for a single-user local app. Must be registered
 * before the SPA `*` fallback in app.ts, or the fallback would swallow `/mcp`.
 */
export function registerMcp(app: Express): void {
  // MCP clients connect over loopback (http://localhost:3002/mcp). Block public
  // (tunnel) requests outright so the endpoint isn't an unauthenticated backdoor.
  // Returns true when the request may proceed; otherwise responds 404 and returns false.
  const allowLocal = (req: Request, res: Response): boolean => {
    if (isLocalhost(req)) return true;
    res.status(404).end();
    return false;
  };

  app.post('/mcp', async (req: Request, res: Response) => {
    if (!allowLocal(req, res)) return;
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error', data: (err as Error).message },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no server-to-client stream and no session to delete.
  const methodNotAllowed = (req: Request, res: Response) => {
    if (!allowLocal(req, res)) return;
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
}
