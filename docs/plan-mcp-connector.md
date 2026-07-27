# Plan: expose `/mcp` as a Claude custom connector (OAuth-gated)

Status: **deferred** (2026-07-27) — nothing implemented. Waiting for `static_headers` to become
available on this account; see `## Outcome`.

## Goal

Make the existing MCP server reachable from claude.ai / Claude Desktop / mobile as a *custom
connector*, without weakening the current security posture: the loopback surface stays exactly as
it is, and the public surface is protected by OAuth 2.1 bearer tokens rather than the session
cookie (which an OAuth client can never obtain).

Target URL: `https://rss.royl.uk:8443/mcp`.

## Why the current setup can't be used as-is

- `internal/mcp.Handler` is mounted only on `NewLocalRouter` (`internal/httpapi/httpapi.go:106`),
  which binds `127.0.0.1:LOCAL_API_PORT` and is never tunneled. The rathole tunnel forwards
  `:3002` — the *public* router — which has no `/mcp` route. `docs/rathole-vps-tunnel.md:413`
  asserts this (`POST /mcp` → 404).
- Anthropic fetches connector URLs server-side from `160.79.104.0/21`, so loopback is unreachable
  by construction.
- The public router's only auth is a session cookie issued by a form login (`internal/auth`).
  Claude supports `oauth_dcr`, `oauth_cimd`, `oauth_anthropic_creds`, `static_headers` (beta),
  `custom_connection`, and `none` — no cookie mode. The Add-custom-connector dialog on this
  account exposes only Name / URL / OAuth Client ID / Secret, i.e. DCR or pre-registered client.
- Transport is already correct: `sdkmcp.NewStreamableHTTPHandler` (go-sdk v1.6.1).

Authless (`none`) is technically supported by Claude but is not acceptable here: the 13 tools
include `add_feed`, `delete_feed`, `import_opml`, `toggle_star`. That would put feed deletion on
the open internet.

## Scope

**In**

1. A minimal OAuth 2.1 authorization server + resource server inside the Go backend
   (`internal/oauth`), supporting DCR + authorization code + PKCE S256 + refresh rotation.
2. Mounting the MCP Streamable HTTP handler on the **public** router behind bearer-token
   verification, gated by a new config flag that defaults to **off**.
3. Metadata discovery documents (RFC 9728 protected resource, RFC 8414 authorization server).
4. Reusing `AUTH_USER`/`AUTH_PASS` + the existing `sessions` table for the human consent step.
5. Token/code storage + expiry cleanup, Go unit tests, docs.

**Out**

- Multi-user accounts, scopes beyond a single `mcp` scope, per-tool permissions.
- CIMD (`client_id_metadata_document_supported`) and `oauth_anthropic_creds` — both exist to avoid
  DCR client explosion at directory scale. A single-person deployment registers a handful of
  clients; DCR is fine.
- Changing `internal/mcp` tool logic. The tools self-call `127.0.0.1:LOCAL_API_PORT` and keep
  working unchanged regardless of which listener served the MCP request.
- Any change to the loopback listener's behaviour (still no auth, still not tunneled).

## Design decisions

**Own the authorization server rather than front an external IdP.** The app already has the
only credential pair that matters (`AUTH_USER`/`AUTH_PASS`) and a session table. Adding Auth0/
WorkOS would mean a second hosted dependency and a second source of downtime for a single-user
reader. The AS surface needed here is small because there is exactly one user and one resource.

**Config flag `MCP_PUBLIC_URL` is the master switch.** Empty (default) → no `/mcp`, no `/oauth/*`,
no `/.well-known/*` on the public router; the deployment behaves exactly as today. Set to
`https://rss.royl.uk:8443/mcp` → the whole surface turns on. This keeps the risky change opt-in
and makes the "off" path the one that runs if config is missing.

**Store hashes, never raw secrets.** Access tokens, refresh tokens, authorization codes and client
secrets are stored as SHA-256 hashes; the raw value exists only in the response body.

**Bearer, not cookie, on `/mcp`.** Note that `auth.Gate` only guards paths under `/api/`
(`internal/auth/auth.go:88`), so a `/mcp` route on the public router is **unauthenticated unless we
wrap it explicitly**. The wrapping is the security boundary — it must be impossible to register the
route without it (build the handler in one constructor that applies the middleware internally).

## Protocol requirements to satisfy

From Claude's connector auth docs (verified 2026-07-27):

- `401` **must** carry `WWW-Authenticate: Bearer resource_metadata="…"`. Claude does not honor the
  header on a `200`.
- PRM `resource` must equal the URL the user types, **exactly**, including path and the `:8443`
  port.
- `authorization_servers[0]` is the only entry Claude reads.
- AS metadata must advertise `code_challenge_methods_supported: ["S256"]` and a
  `registration_endpoint`.
- `/token` must accept `application/x-www-form-urlencoded`; `/register` uses `application/json`.
- Redirect URIs to accept: `https://claude.ai/api/mcp/auth_callback` (hosted surfaces) and, for
  Claude Code, loopback `http://localhost/callback` + `http://127.0.0.1/callback` with the **port
  component ignored** (RFC 8252 §7.3).
- Refresh tokens must rotate (public client) and return `invalid_grant` — not `invalid_request` —
  when no longer valid. Advertise `offline_access` in `scopes_supported` to get a refresh token.
- Latency budget: 10s for discovery/registration/token, 30s for refresh.

## Steps

1. **Config** — add `MCPPublicURL string` to `internal/config` (`MCP_PUBLIC_URL`, default empty).
   Derive `issuer` = scheme+host of that URL, `resource` = the URL verbatim. Validate at startup:
   must be absolute HTTPS (or loopback for dev) and must parse; log-and-refuse to enable otherwise.

2. **Schema** (`internal/db/db.go`, idempotent `CREATE TABLE IF NOT EXISTS` in the same style as
   `push_subscriptions`):
   - `oauth_clients(client_id TEXT PRIMARY KEY, secret_hash TEXT, redirect_uris TEXT, name TEXT, created_at INTEGER)`
     — `redirect_uris` is a JSON array.
   - `oauth_codes(code_hash TEXT PRIMARY KEY, client_id TEXT, redirect_uri TEXT, challenge TEXT, scope TEXT, expires_at INTEGER, consumed INTEGER DEFAULT 0)`
   - `oauth_tokens(access_hash TEXT PRIMARY KEY, refresh_hash TEXT, client_id TEXT, scope TEXT, expires_at INTEGER, refresh_expires_at INTEGER, created_at INTEGER)`

3. **`internal/oauth` package** — a `Provider` holding `*db.DB`, issuer, resource, and a reference
   to the existing `*auth.Authenticator` for the consent step. Endpoints:
   - `GET /.well-known/oauth-protected-resource/mcp` **and** `/.well-known/oauth-protected-resource`
     — serve the same document (Claude probes the path-suffixed form first). Can use
     `sdkauth.ProtectedResourceMetadataHandler` with an `oauthex.ProtectedResourceMetadata`.
   - `GET /.well-known/oauth-authorization-server` — RFC 8414 doc: `issuer`, `authorization_endpoint`,
     `token_endpoint`, `registration_endpoint`, `response_types_supported: ["code"]`,
     `grant_types_supported: ["authorization_code","refresh_token"]`,
     `code_challenge_methods_supported: ["S256"]`,
     `token_endpoint_auth_methods_supported: ["none","client_secret_post"]`,
     `scopes_supported: ["mcp","offline_access"]`.
   - `POST /oauth/register` (JSON, RFC 7591) — accept `redirect_uris`, `client_name`; reject any
     redirect URI outside the allowlist in "Protocol requirements". Issue `client_id` and, for
     non-public clients, `client_secret`. Rate-limit.
   - `GET /oauth/authorize` — validate `client_id`, `redirect_uri` (exact match against the
     registered set, port-agnostic for loopback), `response_type=code`, `code_challenge` +
     `code_challenge_method=S256` (reject anything else). If the request carries a valid `session`
     cookie, render a server-side consent page showing the **redirect URI hostname** (spec
     requirement) with an approve button; otherwise render a minimal self-contained login form that
     posts credentials to `POST /oauth/authorize` and, on success, sets the session cookie and
     falls through to consent. Reuse `auth`'s rate limiter and timing-safe compare — this needs two
     small exported helpers on `Authenticator` (`ValidRequest(r) bool`, `Login(user, pass) (token,
     bool)`); keep the existing unexported methods delegating to them so `/api/login` is untouched.
     Approve → mint a one-time code (60s TTL), 302 back with `code` + `state`.
   - `POST /oauth/token` (form-urlencoded):
     - `grant_type=authorization_code`: verify code unconsumed + unexpired + client + redirect_uri
       match + `S256(code_verifier) == challenge`; mark consumed atomically (single UPDATE with
       `WHERE consumed = 0`, check RowsAffected — replay protection).
     - `grant_type=refresh_token`: verify, **rotate** (issue new pair, delete old row in the same
       transaction).
     - Errors as RFC 6749 JSON with correct codes (`invalid_grant`, `invalid_client`,
       `unsupported_grant_type`).
     - Access token TTL 1h, refresh TTL 30d (matches the session TTL already in use).

4. **Bearer gate + mount** — a constructor in `internal/oauth` returning the wrapped MCP handler:
   `sdkauth.RequireBearerToken(provider.VerifyToken, &sdkauth.RequireBearerTokenOptions{
   ResourceMetadataURL: …})` around `mcp.Handler(s.LocalAPIPort)`. `VerifyToken` looks up the
   SHA-256 of the presented token, checks expiry, returns `*sdkauth.TokenInfo`. Confirm the SDK
   emits the `WWW-Authenticate: Bearer resource_metadata="…"` challenge on 401; if it doesn't, add
   the header ourselves — this is the single most load-bearing line in the whole flow.

5. **Wire into `NewPublicRouter`** — when `MCPPublicURL != ""`, register the `/.well-known/*` and
   `/oauth/*` routes and `r.Handle("/mcp", gatedMCP)`. All of these sit outside `/api/`, so
   `auth.Gate` ignores them (correct) and `apiNoStore` doesn't touch them — set `Cache-Control:
   no-store` explicitly on token/authorize responses. Registered routes win over the SPA `NotFound`
   fallback, so no conflict with `spaFallback`. Also thread `MCPPublicURL` through `main.go` into
   `httpapi.Server`.

6. **Cleanup job** — in `internal/jobs/maintenance.go`, delete expired `oauth_codes` and
   `oauth_tokens` rows on the existing maintenance tick. Codes expire in 60s and would otherwise
   accumulate forever.

7. **Tests** (`make check`, offline):
   - DCR rejects a non-allowlisted `redirect_uri`; accepts the two Claude forms; accepts loopback
     on an arbitrary port.
   - `authorize` rejects `code_challenge_method=plain` and a missing challenge.
   - Code is single-use (second exchange → `invalid_grant`) and expires.
   - PKCE verifier mismatch → `invalid_grant`.
   - Refresh rotates and the old refresh token is dead afterwards.
   - `/token` accepts form-urlencoded and rejects JSON with a clear error.
   - Public `/mcp` without a token → 401 **with** the `WWW-Authenticate` `resource_metadata`
     pointer; with a valid token → 200.
   - With `MCP_PUBLIC_URL` empty: `/mcp`, `/oauth/*`, `/.well-known/*` all 404 on the public router.
   - `NewLocalRouter` still serves `/mcp` with no token (regression guard on the loopback path).

8. **Deploy + manual verification** (extends `docs/rathole-vps-tunnel.md`):
   - `curl -i https://rss.royl.uk:8443/.well-known/oauth-protected-resource/mcp`
   - `curl -i -X POST https://rss.royl.uk:8443/mcp` → 401 + `WWW-Authenticate`
   - Confirm SSE streaming survives Caddy + rathole (Streamable HTTP may hold a `text/event-stream`
     response open; check Caddy isn't buffering and no idle timeout kills it).
   - Add the connector in claude.ai with URL `https://rss.royl.uk:8443/mcp`, leave the OAuth fields
     blank (DCR path), complete login + consent, then call `list_feeds` from a chat.
   - Update `docs/rathole-vps-tunnel.md:413`, which currently asserts `/mcp` → 404.
   - Update `CLAUDE.md` (the MCP section says "loopback only" — that stops being the whole truth).

## Risks / open questions

1. **Blast radius.** The connector exposes `delete_feed`, `import_opml`, `add_feed` to anything
   holding a token. Mitigation options, in order of preference: (a) accept it — same blast radius
   as the password that already fronts the app; (b) expose a read-only tool subset on the public
   mount and keep the mutating tools loopback-only. **Open question — needs a decision before
   step 4.** (b) is a ~20-line change in `NewServer` (a `readOnly bool` filtering registration) and
   is worth it if the connector is only ever used for reading articles.
2. **Non-standard port `:8443`.** Anthropic's fetcher should handle it, but this is unverified and
   would be discovered late. **Verify early** with the `curl` checks in step 8 before writing the
   OAuth layer — if Anthropic's fetcher refuses non-443 ports, the whole plan needs a different
   ingress (a second Caddy site on 443 for another hostname) and the effort estimate changes.
3. **Rolling my own AS.** Auth-code + PKCE is small but unforgiving. The specific failure modes to
   test are all in step 7; the ones that silently degrade to insecure are: accepting `plain` PKCE,
   non-atomic code consumption, and loose `redirect_uri` matching (open redirector).
4. **Home IP exposure / availability.** The app runs on a Mac behind a home connection. A connector
   that Claude polls will make outages visible as connector errors. Cosmetic, not a blocker.
5. **`static_headers` might be simpler.** Claude supports a fixed bearer token entered as a request
   header (beta, org-admin surface). If that field is available on this account, it replaces steps
   1–7 with roughly 30 lines (compare a constant token, keep the same mount). The Add-connector
   dialog screenshot shows no header field, so assume unavailable — but **check the dialog once
   more before starting**; the saving is an order of magnitude.
6. **go-sdk 401 shape.** `sdkauth.RequireBearerToken` is the intended server-side helper, but
   whether its challenge includes `resource_metadata` in the exact form Claude parses is unverified
   against the current SDK version. Assert it in a test rather than trusting it.

## Complexity

**High** — new security-critical package, new tables, a public-surface change, and an integration
that can only be fully verified against Anthropic's infrastructure. Estimate ~600–800 lines of Go
plus tests. If open question (5) resolves in favour of `static_headers`, it drops to **Low**.

## Outcome

2026-07-27 — **deferred, nothing built.** Decision: wait for `static_headers` (Claude's fixed
request-header credential, currently beta and not offered in this account's Add-custom-connector
dialog) rather than implement the OAuth authorization server in steps 1–7.

Rationale: the OAuth path is the expensive *and* risky half of this plan — a hand-rolled auth-code
server whose failure modes (accepting `plain` PKCE, non-atomic code consumption, loose
`redirect_uri` matching) degrade silently into insecurity. `static_headers` reaches the same
endpoint with a constant-time token compare in front of the same mount, so the waiting cost is near
zero and the saving is roughly an order of magnitude.

**Trigger to revisit:** a header/credential field appearing in the Add-custom-connector dialog, or
`static_headers` leaving beta in
https://claude.com/docs/connectors/building/authentication.

**What survives regardless of which auth mode wins** — these are still the steps to take on the day:

- Step 2's mount question: `/mcp` on `NewPublicRouter` is *unauthenticated by default* because
  `auth.Gate` only guards `/api/*` (`internal/auth/auth.go:88`). Mount and gate in one constructor.
- Step 1's `MCP_PUBLIC_URL` master switch, defaulting to empty/off.
- Risk 1 (read-only tool subset vs. full 13 tools) is unresolved and still needs a decision.
- Risk 2: verify Anthropic's fetcher accepts the non-standard `:8443` port **before** any other
  work. This is cheap and invalidates everything downstream if it fails.
- `docs/rathole-vps-tunnel.md:413` and the MCP section of `CLAUDE.md` both assert loopback-only and
  will need updating.
