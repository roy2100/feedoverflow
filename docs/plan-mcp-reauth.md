# Plan: Restore MCP under uniform auth

## Goal

Make the MCP server's tools work again when `AUTH_USER`/`AUTH_PASS` are set. As of
commit `2c1fc27` the auth gate requires a valid session on **every** `/api/*` request
(no localhost bypass). MCP's tools call the HTTP API over loopback in-process
(`server/mcp.ts` `request()` → `http://localhost:3002`) with no session cookie, so
every MCP tool call now returns `401`. MCP is currently only functional with auth
disabled. Restore it without reopening an IP-based auth bypass.

## Scope

**In scope**
- Authenticate MCP's internal loopback calls so they pass the gate when auth is on.
- Keep external `/api/*` requests strictly session-gated (no IP trust regression).
- Keep the existing MCP transport restriction (`/mcp` localhost-only, remote → 404).

**Out of scope**
- Changing the public auth model for browser/API clients.
- Exposing any MCP surface over the tunnel.

## Options

1. **Internal secret header (preferred).** Generate a random per-boot token in-process;
   the gate accepts requests bearing it (constant-time compare); `mcp.ts` `request()`
   attaches it. No IP trust — safe even if `req.ip` is spoofed to localhost. Token never
   leaves the process.
2. **Startup-minted session.** Create a long-lived session row at boot and have `mcp.ts`
   send it as the `session` cookie. Reuses the session table; simplest wiring, but the
   token is a real session that grants full access if leaked.
3. **Direct handler calls.** Refactor MCP to call route handlers / service functions
   directly instead of over HTTP, sidestepping the gate. Cleanest long-term, largest diff.

## Steps (option 1)

1. In `auth.ts`, generate `INTERNAL_TOKEN = crypto.randomBytes(32).toString('hex')` at
   module load; export a guard the gate consults.
2. In the gate, before the 401, accept the request if the `X-Internal-Token` header
   matches `INTERNAL_TOKEN` via `crypto.timingSafeEqual`.
3. In `mcp.ts` `request()`, attach `X-Internal-Token: INTERNAL_TOKEN` to every call.
4. Tests: MCP tool call succeeds with auth enabled; a forged/absent header from a remote
   client still 401s.

## Risks & Open Questions

- Header spoofing: an external client could send `X-Internal-Token`. Mitigated by a
  32-byte random secret never exposed externally; optionally also require loopback IP.
- Two trust paths (session cookie + internal token) — keep the token path narrow and
  in-process only.

## Estimated Complexity

Low — option 1 is ~15 lines plus a test.
