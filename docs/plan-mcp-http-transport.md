# Plan: Migrate MCP server to HTTP transport (inside Express server)

## Goal
The RSS reader ships an MCP server that currently runs as a separate stdio process
(`server/mcp/server.js`) launched by Claude via `node`. Migrate it to the Streamable
HTTP transport and mount it directly inside the existing Express server on port 3002,
so there is one process to run/deploy instead of two and the MCP endpoint is reachable
over HTTP at `http://localhost:3002/mcp`.

## Scope
- Included: new `server/mcp.ts` module exposing the same 13 tools over Streamable HTTP;
  mounting it in `server/app.ts`; adding SDK + zod deps to `server/package.json`;
  updating `~/.claude.json` rss-reader entry to `type: "http"`; removing the old
  standalone `server/mcp/` directory.
- Out of scope: refactoring the tool implementations to call DB logic directly — tools
  keep self-calling `http://localhost:3002` (loopback, auth-exempt), which is the
  smallest, lowest-risk change. No auth on `/mcp` (localhost-only, like the rest).

## Steps
1. Add `@modelcontextprotocol/sdk` + `zod` to `server/package.json`; `npm install`.
2. Create `server/mcp.ts`: `buildServer()` registers the same tools as the old
   `server.js`; `registerMcp(app)` mounts a stateless Streamable HTTP transport at
   `POST /mcp` (fresh server+transport per request, `sessionIdGenerator: undefined`),
   with `405` on `GET`/`DELETE /mcp`.
3. Call `registerMcp(app)` in `server/app.ts` before the SPA `*` fallback.
4. Typecheck (`npm run typecheck`) and smoke-test the endpoint with a JSON-RPC
   `initialize` + `tools/list` over curl.
5. Update `~/.claude.json` rss-reader server to `{ type: "http", url: "http://localhost:3002/mcp" }`.
6. Remove `server/mcp/` directory.

## Risks & Open Questions
- The MCP routes must be registered before `app.get('*')` or the SPA fallback swallows them.
- Self-fetch loopback is slightly wasteful but avoids duplicating route logic; acceptable
  for a single-user local app.
- Claude Code must reconnect to pick up the new transport (restart / reload config).

## Estimated Complexity
Medium — mechanical, but touches deps, a new module, app wiring, external config, and cleanup.

## Outcome
Done as planned.
- Added `@modelcontextprotocol/sdk@^1.29.0` + `zod@^3.23.8` to `server/package.json`.
- Created `server/mcp.ts` (`buildServer()` + `registerMcp(app)`), stateless Streamable
  HTTP at `POST /mcp`, 405 on `GET`/`DELETE`. Tools self-call `http://localhost:3002`.
- Wired `registerMcp(app)` into `app.ts` just before the SPA `*` fallback.
- Smoke test: `initialize` 200, `tools/list` 200 (14 tools), `GET /mcp` 405. Full suite
  30/30 pass, typecheck clean.
- Updated `~/.claude.json` rss-reader entry to `{ "type": "http", "url": "http://localhost:3002/mcp" }`.
- Removed `server/mcp/`.
- Documented the endpoint in `CLAUDE.md`.

Deviation: none. Note — Claude Code must reload its MCP config, and the deployed launchd
server (`~/Deploy/rss-reader`) must be redeployed (`./deploy.sh`) before `/mcp` is live in
production; the dev server picks it up on next start.
