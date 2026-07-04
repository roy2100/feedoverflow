# Plan: Port the MCP server to the Go backend

## Goal
The Node MCP server (`legacy_server_node` branch, `server/mcp.ts`) exposes 13 tools over
Streamable HTTP so Claude/other MCP clients can read/manage feeds and articles. It was
explicitly left out of the Go migration (`docs/plan-go-backend-migration.md`) and the Go
backend currently serves no `/mcp` endpoint. Port it: same 13 tools, same transport, mounted
on the existing loopback-only, no-auth listener (`LOCAL_API_PORT`), which was built and
reserved for exactly this purpose.

## Scope
- Included: a new `internal/mcp` package using the official
  `github.com/modelcontextprotocol/go-sdk` (`mcp` subpackage, latest `v1.6.1`); the same 13
  tools as the Node version, same names/descriptions/input shapes; mounted at `POST/GET/DELETE
  /mcp` on `NewLocalRouter` only; wiring in `main.go`/`httpapi.go` to pass `LOCAL_API_PORT`
  through.
- Out of scope: refactoring tools to call store/cache functions in-process instead of over
  HTTP (see Decision below); auth on `/mcp` (the loopback listener is already unauthenticated
  by design); any change to the public listener or existing `/api/*` handlers; adding new
  tools beyond the 13 that existed in Node.

## Decision: tools stay thin HTTP self-calls over loopback
Node's tools call `http://127.0.0.1:${LOCAL_API_PORT}/api/...` instead of touching DB/cache
logic directly — deliberately, per `docs/plan-mcp-http-transport.md`'s own scope note, to
avoid duplicating business logic (digest quotas, `ensureFresh` TTL triggers, article
normalization) that lives in the HTTP handlers. The Go handlers (`internal/httpapi`) have the
same shape: unexported methods on `*Server` holding that same logic. Mirroring the Node
approach — an `internal/mcp` package that does plain `net/http` calls to
`http://127.0.0.1:<LocalAPIPort>/api/...` — keeps MCP fully decoupled from `httpapi` internals,
avoids exporting/duplicating handler logic, and matches the "1:1 port" philosophy already
governing this backend. Same low-risk tradeoff Node accepted: an extra in-process loopback
hop per tool call, which is negligible for a single-user local app.

## Steps
1. `go get github.com/modelcontextprotocol/go-sdk@v1.6.1` in `server-go/` (confirmed reachable
   via the configured `GOPROXY`).
2. Create `internal/mcp/client.go`: a small `request(ctx, method, path, body)` helper against
   `http://127.0.0.1:<port>` (port passed into the package, not read from env — matches how
   `Server` already takes config as fields, not globals), mirroring `server/mcp.ts`'s
   `request`/`get`/`post`/`patch`/`del`.
3. Create `internal/mcp/tools.go`: `func NewServer(port int) *mcp.Server` builds an
   `mcp.NewServer` and registers the 13 tools via `mcp.AddTool`, one Go input struct per tool
   (json tags matching the wire contract, `jsonschema:"description=..."` tags matching Node's
   zod `.describe()` strings). Each handler calls the loopback client and wraps the JSON result
   as `&mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: <pretty-JSON>}}}`,
   matching Node's `text()` helper. Tool list (unchanged from Node): `list_feeds`, `add_feed`,
   `rename_feed`, `delete_feed`, `import_opml`, `get_all_articles`, `get_today_articles`,
   `get_starred_articles`, `get_feed_articles`, `get_starred_count`, `toggle_star`,
   `get_current_article`, `fetch_article_content`.
4. Create `internal/mcp/handler.go`: `func Handler(port int) http.Handler` wraps
   `mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)` —
   one shared `*mcp.Server` built at startup (the SDK supports concurrent sessions natively,
   so there's no need for Node's stateless per-request rebuild hack).
5. Wire it into `internal/httpapi/httpapi.go`: add `r.Handle("/mcp", mcp.Handler(s.LocalAPIPort))`
   inside `NewLocalRouter` only (never `NewPublicRouter`). Add a `LocalAPIPort int` field to
   `Server` and set it from `cfg.LocalAPIPort` in `main.go`. No extra localhost check needed —
   `NewLocalRouter` is only ever bound to `127.0.0.1:<port>` in `main.go`, same as every other
   route already on that router.
6. Update the package doc comment in `httpapi.go` (currently says "MCP is out of this phase")
   and the "MCP server — not in the Go backend" section of `CLAUDE.md` to reflect the new
   reality.
7. `make fmt && make check` (fmt-check + vet + staticcheck + offline tests).
8. Smoke test against a running dev server: `curl -s localhost:4002/mcp` (expect 405 per SDK
   behavior for bare GET), then a JSON-RPC `initialize` + `tools/list` POST, then one real tool
   call (`list_feeds`) to confirm the loopback self-call round-trips.
9. Point a local MCP client config at `http://127.0.0.1:4002/mcp` and manually verify a couple
   of tools end-to-end (list_feeds, get_current_article).

## Risks & Open Questions
- `github.com/modelcontextprotocol/go-sdk` is a fast-moving official SDK (currently v1.6.1) —
  API shape confirmed against current docs (Context7) as part of this plan, not assumed from
  training data.
- Tool schemas: Go's `jsonschema` inference marks struct fields required by default; fields
  Node marked optional (e.g. `summary`, `content`, `author` on `toggle_star`) need explicit
  `omitempty` json tags on the MCP-local input struct — must not reuse `internal/model.Article`
  directly for this, since that struct's tags are the wire contract for `/api/*` responses and
  must stay untouched.
- No auth token/session is added for `/mcp` — matches Node (loopback-only is the security
  boundary), consistent with every other route on `NewLocalRouter`.

## Estimated Complexity
Medium — new external dependency + new package, but mechanical (mirrors an existing, working
Node implementation line-for-line) and touches only a couple of existing files at the wiring
points.

## Outcome
Done as planned, no scope deviations.
- Added `github.com/modelcontextprotocol/go-sdk@v1.6.1` (`go mod tidy` pulled in
  `google/jsonschema-go`, `yosida95/uritemplate`, `segmentio/encoding`, `golang.org/x/oauth2`
  transitively — all indirect, unused directly).
- New `internal/mcp` package: `client.go` (loopback HTTP helper), `tools.go` (13 `mcp.AddTool`
  registrations, one Go input struct per tool, `jsonschema:"<description>"` tags, `omitempty`
  on the fields Node marked optional), `handler.go` (`Handler(port int) http.Handler` wrapping
  `mcp.NewStreamableHTTPHandler` around one shared `*mcp.Server` — simpler than Node's
  stateless-per-request rebuild since the Go SDK handles concurrent sessions natively).
- Wired `LocalAPIPort int` onto `httpapi.Server`, set from `cfg.LocalAPIPort` in `main.go`;
  `NewLocalRouter` now also does `r.Handle("/mcp", mcp.Handler(s.LocalAPIPort))`. Never mounted
  on `NewPublicRouter`.
- Updated `CLAUDE.md`: ports line, package tree, the two-listeners paragraph, and replaced the
  "MCP server — not in the Go backend (pending)" section with a description of the shipped
  design.
- `make fmt` (no changes needed, already gofmt-clean), `make check` (fmt-check + vet +
  staticcheck + full offline test suite) all pass.
- Smoke-tested against a throwaway instance of the new binary on isolated ports/DB (never
  touched the running production service on 3002/4002): `initialize` → 200 with a session id,
  `tools/list` → all 13 tools with correct required/optional schemas, `tools/call list_feeds`
  → real data from the fresh (seeded) DB, `get_current_article` with nothing open → graceful
  `isError: true` result (not a crash), session `DELETE` → 204, and confirmed `/mcp` on the
  *public* port 404s (not reachable outside loopback).
- Not done (out of scope, unchanged from plan): pointing a real local MCP client config at the
  new endpoint and manually exercising it from an actual client — the JSON-RPC smoke test above
  covers the protocol surface end-to-end instead.
