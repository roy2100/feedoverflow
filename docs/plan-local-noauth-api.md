# Plan: Loopback-only no-auth API + move MCP off the public port

## Goal

Expose the **full RSS HTTP API without login** on a second Express listener bound to
`127.0.0.1` only, and move the MCP endpoint (`POST /mcp`) onto that same loopback-only
listener. The public port (`3002`, all interfaces, reachable via the rathole tunnel and
LAN) keeps its session auth gate and loses the MCP surface entirely. "Whether auth
applies" becomes a property of *which socket the request arrived on* — decided by the
listening port, not by a spoofable `X-Forwarded-For`/`req.ip`. This supersedes the
internal-token design in `plan-mcp-reauth.md` and closes the `todo-mcp-reauth` item.

## Scope

**In scope**
- New loopback-only Express app (no auth, no SPA) mounting the same `routes/` routers.
- Move `registerMcp` from the public `app` to the local app; MCP's internal loopback
  calls repoint to the local no-auth port.
- New `LOCAL_API_PORT` config (default `3003`), bound to `127.0.0.1`.
- A second `listen(..., '127.0.0.1')` in `index.ts`, fatal on bind error.
- Update `CLAUDE.md` / `README.md` MCP client URL and docs; refresh the memory TODO.

**Out of scope**
- The public browser/LAN/tunnel auth model — unchanged.
- Exposing any API or MCP surface over the tunnel (rathole still forwards only `3002`).
- Adding the local port to any tunnel/proxy config (it must stay private).

## Steps

1. `config.ts` — add `export const LOCAL_API_PORT = Number(process.env.LOCAL_API_PORT) || 3003;`.
2. `app.ts` — extract a `mountRouters(app)` helper; keep the public `app` as
   cors+compression+static+`registerAuth`+routers+SPA (drop `registerMcp`). Add and
   export `localApp`: `express.json` → no-store `/api` → `mountRouters` → `registerMcp`.
   No auth, no static, no SPA (unknown paths 404 naturally).
3. `mcp.ts` — point `BASE_URL` at `http://127.0.0.1:${LOCAL_API_PORT}`. Keep the
   `isLocalhost` guard as redundant defense-in-depth (the socket is already loopback-only).
4. `index.ts` — after the main bind, `localApp.listen(LOCAL_API_PORT, '127.0.0.1', ...)`;
   log start; fatal + exit on `error`.
5. Tests — `local-api.test.ts`: with auth enabled, `localApp` serves `/api/feeds`
   without a session cookie; `POST /mcp` on `localApp` responds; `GET /mcp` → 405; and
   `POST /mcp` on the public `app` is no longer routed (404).
6. Docs/memory — update MCP URL to `http://localhost:3003/mcp`, the port table, the MCP
   section caveat (auth no longer breaks it), and `todo-mcp-reauth` memory (resolved).

## Risks & Open Questions

- **Binding scope**: the local app MUST bind `127.0.0.1` (not `0.0.0.0`), or it becomes
  an unauthenticated LAN backdoor. Explicit host arg in `listen`.
- **Port collision**: `3003` is currently free (3000 dev client, 3001 networth, 3002 rss).
  Overridable via `LOCAL_API_PORT`.
- **Client reconfig**: existing MCP clients pointed at `:3002/mcp` must switch to
  `:3003/mcp` (update `~/.claude.json`). Documented, not code.
- **Deploy**: launchd runs one process; the second listener starts in the same process,
  so no plist change is required. `deploy-mac.sh` needs no change.

## Estimated Complexity

Low–Medium — ~4 small source edits + one test + docs. No new dependencies.

## Outcome

Done as planned, no deviations.

- `server/config.ts` — added `LOCAL_API_PORT` (default 3003).
- `server/app.ts` — added `noStore` middleware + `mountRouters()`; dropped `registerMcp`
  from the public `app`; added and exported `localApp` (`json` → no-store `/api` →
  `mountRouters` → `registerMcp`), no auth/static/SPA.
- `server/mcp.ts` — `BASE_URL` → `http://127.0.0.1:${LOCAL_API_PORT}`; kept `isLocalhost`
  as defense-in-depth; refreshed comments.
- `server/index.ts` — second listener `localApp.listen(LOCAL_API_PORT, '127.0.0.1')`,
  fatal on bind error.
- `server/test/local-api.test.ts` — 4 tests: `localApp` serves `/api` unauthenticated
  while public `app` 401s; `POST /mcp` served on `localApp`; `GET /mcp` → 405; `POST /mcp`
  not routed on the public `app` (404). All pass.
- Docs: `CLAUDE.md` (ports, tree, assembly, auth, MCP section), `README.md` MCP URL →
  `:3003/mcp`; memory `todo-mcp-reauth` marked resolved.
- Verified: `npm test` 90/90 pass (typecheck included), `npm run fmt:check` clean,
  `npm run lint` exit 0. Superseded design: `docs/plan-mcp-reauth.md` (internal-token).

**Follow-up (manual, not code):** point the MCP client at `http://localhost:3003/mcp`
in `~/.claude.json`, and redeploy the Mac service (`./scripts/deploy-mac.sh`) so the
running process opens the new listener.
