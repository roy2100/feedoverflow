# Plan: Public Read-Only Mode (anonymous demo, full access when logged in)

## Goal

Serve one deployment that works as a **public, no-login read-only demo** for anonymous
visitors while remaining the owner's **full read/write daily driver** once logged in (or on
localhost). This lets the repo carry a live demo link for the résumé without exposing the
database to vandalism by anonymous visitors. Keep the code change minimal: gate at the
existing auth middleware, no frontend UI changes — blocked writes simply surface the
server's error.

## Scope

**In scope**
- Backend auth gate: anonymous `GET` → allowed (reads); anonymous writes (non-`GET`) → `403`.
- Preserve owner flow: valid session or localhost → full access; expired/invalid session → `401`
  (so the client's existing reload-to-relogin path still fires).
- Confirm `/mcp` stays auth-gated so anonymous visitors cannot drive write tools via MCP.
- Decide + (optionally) implement an SSRF guard for the GET fetchers now reachable anonymously.

**Out of scope**
- Hiding/disabling frontend write buttons (explicitly not wanted — the 403 error is acceptable UX).
- Anonymous read-only MCP server (a possible later flex; not now).
- Periodic DB reset / seed snapshots.
- Cloudflare Tunnel / deployment infra (already exists; configured separately).

## Steps

1. **Auth gate change — `server/auth.ts`** ✅ *(done)*
   In the non-localhost gate: if a session cookie is present but invalid/expired → `401`
   (client reloads to re-login). If no session at all → anonymous: `GET` passes, any other
   method returns `403 { error: '只读演示模式，登录后可写' }`. `403` (not `401`) is required so
   `apiFetch` does not trigger `window.location.reload()` on every anonymous write.

2. **Verify MCP gating — `server/mcp.ts`**
   Confirm the `/mcp` handler already rejects non-localhost requests without a valid session
   (it imports `isLocalhost`). If it relies only on the old `/api/*` middleware, add an explicit
   session check so anonymous visitors cannot call write tools. No change if already gated.

3. **SSRF decision — `server/app.ts`**
   `GET /api/fetch-content?url=` and `GET /api/favicon?domain=` make the server fetch a
   client-supplied URL; they are now reachable by anonymous visitors. Either (a) add a guard
   that resolves the host and rejects loopback / RFC-1918 / link-local / `169.254.169.254`, or
   (b) consciously accept the risk for a low-value home demo. Recommended: (a).

4. **Local verification (curl)**
   With `AUTH_USER`/`AUTH_PASS` set, from a non-localhost origin (or simulated): anonymous
   `GET /api/all-articles` → `200`; anonymous `POST /api/feeds` → `403`; anonymous
   `POST /api/current-article` → `403` but only logged client-side (fire-and-forget); after
   `POST /api/login`, the same writes → `200`. Confirm no reload loop in the browser.

5. **Build, deploy, smoke-test**
   `./deploy.sh`, then load the public URL anonymously (browse/search/read works, a write shows
   the read-only error), then log in and confirm full access.

## Risks & Open Questions

- **SSRF (step 3)** is the one genuine security hole this opens; needs an explicit decision.
- **Owner session expiry:** an expired session on a write now returns `401` → reload-to-relogin
  (preserved). Reads still succeed anonymously in the meantime. Acceptable.
- **MCP exposure:** if `/mcp` turns out to be ungated, anonymous write-tool access would bypass
  the whole scheme — step 2 must confirm before deploy.
- **Auth must be enabled in prod:** if `AUTH_USER`/`AUTH_PASS` are unset, `registerAuth` makes
  everyone fully authed and there is no read-only mode. The deploy `.env` must set them.

## Estimated Complexity

Low — backend-only, ~10 lines for the gate (done), plus a small SSRF guard if chosen and a
verification pass. No frontend changes.

## Outcome

Implemented, backend-only, no frontend changes (per request — blocked writes just surface
the server error):

1. **Auth gate (`server/auth.ts`)** — anonymous `GET` passes (read-only public demo);
   anonymous writes → `403 {error:'只读演示模式，登录后可写'}`; a present-but-expired session →
   `401` (preserves the client's reload-to-relogin); valid session / localhost → full access.
   `403` (not `401`) avoids `apiFetch`'s reload-on-401 loop for anonymous writers.
2. **MCP (`server/mcp.ts`)** — no change needed. `/mcp` is already localhost-only
   (`allowLocal` → `404` for any non-loopback request), so anonymous visitors can't reach the
   write tools at all.
3. **SSRF guard (`server/ssrf.ts`, new)** — `assertSafeUrl()` resolves the host and rejects
   loopback / RFC-1918 / CGNAT / link-local (incl. `169.254.169.254`) / IPv6 ULA+loopback and
   non-http(s) schemes. Wired only into `GET /api/fetch-content` (the one anonymously-reachable
   server-side fetch). **Deliberately not** applied to the feed-add/RSSHub path, which
   legitimately targets `localhost:1200`. `favicon` was found not to be a vector (it only ever
   fetches `google.com`).

**Verification:** `assertSafeUrl` tested functionally on Node 24 against 11 block + 3 allow
cases — all pass. Full `tsc`/`node:test` not run locally because server `node_modules` isn't
installed; run `cd server && npm install && npm test` before deploy.

**Deploy notes:** prod `server/.env` must set `AUTH_USER`/`AUTH_PASS` (otherwise everyone is
fully authed and there is no read-only mode). Then `./deploy.sh` and smoke-test anonymous read
vs. write, and logged-in full access.
