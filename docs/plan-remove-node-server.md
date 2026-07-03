# Plan: Remove the legacy Node.js backend (`server/`)

## Goal
The Go backend (`server-go/`) is a drop-in replacement for the original Node/Express
backend (`server/`): it serves the same API on the same ports (3002 public, 4002 loopback)
against the same SQLite schema, and the CI already treats the Node tree as out of scope,
"kept solely as a rollback target and will be removed once the Go cutover is closed out."
This task closes out that cutover: preserve the full Node backend on a `legacy_server_node`
branch as a permanent archive/rollback point, then delete it from `main` along with the
tooling that existed only to run, deploy, or measure it.

## Scope
Included (on `main`):
- Delete `server/` (tracked files only — the gitignored `server/rss.db*` and `server/.env`
  in the working tree are left untouched so live/dev data is not destroyed).
- Delete the two Go test-oracle generators that import the Node server:
  `server-go/internal/dates/gen_oracle.mjs`, `server-go/internal/feed/gen_persist_oracle.mjs`.
  Their committed golden JSON stays, so the Go tests keep passing.
- Delete Node-only tooling: `scripts/deploy-mac.sh`, `scripts/install-service-mac.sh`,
  `scripts/install-service-linux.sh`, `scripts/loc.sh`, `loc.md`.
- Fix root `package.json` so `dev`/`server` run the Go backend instead of `node index.ts`.
- Update `README.md` and `CLAUDE.md` so they describe the Go backend, not the deleted Node one.

Out of scope:
- `server-go/` behavior — unchanged.
- Backend-agnostic ops scripts kept as-is: `scripts/burst-latency.sh`, `service-stats-*`,
  `uninstall-service-*`, `update-linux.sh` (they key off the shared launchd label / a running
  HTTP port, not the Node source tree).
- `script-go/rollback.sh`'s "back to Node" path — it restores a deploy-time plist backup on
  the deployed Mac, independent of this repo; the `legacy_server_node` branch remains the
  source-level rollback.
- The gitignored production DB at `~/Deploy/rss-reader/server/rss.db` — untouched.

## Steps
1. Create `legacy_server_node` from the current `main` HEAD and push it to `origin` — the
   archive/rollback point that preserves the entire Node backend and its tooling.
2. On `main`, `git rm -r server/` and `git rm` the orphaned `.mjs` generators, Node-only
   scripts, and `loc.md`.
3. Rewrite root `package.json` scripts: `server` → run the Go backend (`cd server-go && go run .`),
   `dev` → Go backend + client via `concurrently`.
4. Update `README.md` backend section (Node/Express → Go) and `CLAUDE.md` (Commands + the
   `Server (server/)` section + file tree → `server-go/`). The API table, data-flow semantics,
   and SQLite schema stay valid — they were ported 1:1 (that is what the oracle tests enforce).
5. Verify: `cd server-go && make check` (Go fmt/vet/staticcheck/tests), `cd client && npm run
   typecheck && npm test`, and `npm run fmt:check && npm run lint` at the root.
6. Commit on `main` and push. Append the Outcome section below.

## Risks & Open Questions
- **Live data loss** — mitigated: only tracked files are removed; gitignored `server/rss.db*`
  and `server/.env` are left in place.
- **Broken oracle regeneration** — accepted: the `.mjs` generators can no longer run without
  the Node server, but the golden JSON they produced is committed and the Go tests read that,
  so the suite is green. Regenerating oracles would now require the `legacy_server_node` branch.
- **Doc drift** — `CLAUDE.md` is large; the rewrite targets the sections rendered factually
  wrong by the deletion and relies on `server-go/` facts that were read directly (package
  layout, Makefile targets, config env vars), not invented.
- Scope of surrounding cleanup was proposed to the user as a question; the user was away, so
  the "full cutover" option was taken as the best-judgment default consistent with the CI note.

## Estimated Complexity
Medium — mechanical deletion plus careful, verifiable doc edits; low logic risk because the
Go backend and its tests are untouched.

## Outcome
Done as planned, plus two items discovered during execution.

- **Archive branch:** `legacy_server_node` created from `main` HEAD (`768ac8a`) and pushed to
  `origin` — the full Node backend + all its tooling is preserved there.
- **Deleted on `main`:** the `server/` tree (43 tracked files), the two `.mjs` oracle
  generators, and Node-only tooling (`scripts/deploy-mac.sh`, `install-service-mac.sh`,
  `install-service-linux.sh`, `loc.sh`, `loc.md`). Live `server/.env` and `server/rss.db*`
  (gitignored) were left on disk — not deleted.
- **Also removed (discovered mid-task):** `server-go/scripts/contract-diff.sh` and its
  `make contract-diff` target — the same class of Node-dependent harness as the `.mjs`
  generators (it launched the Node server to diff responses), now unrunnable. `cmd/freezefeeds`
  (pure Go) was kept.
- **Docs/config retargeted to Go:** root `package.json` (`server` → `cd server-go && go run .`),
  `README.md`, `CLAUDE.md` (Commands, Deployment, Architecture tree, `### Server` section, MCP
  section), `.github/workflows/ci.yml` comment, and `.oxfmtrc.json`/`.oxlintrc.json` (dropped the
  dead `server/vendor/**` ignore; added `server-go/**` to oxfmt so root `fmt:check` is green — the
  Go tree is owned by gofmt/staticcheck, and its committed oracle JSON must not be reformatted).
- **MCP gap surfaced (important):** the Go migration deliberately did **not** port the MCP
  server, so removing the Node backend removes the live `/mcp` endpoint until it is ported to Go.
  The loopback listener is kept and reserved as the future host. README + CLAUDE.md now state this
  explicitly; the working MCP implementation lives on `legacy_server_node`.
- **Verification (all green):** `go build ./...`, `go test ./...`, client `tsc --noEmit` + 84
  vitest tests, root `oxfmt --check .` and `oxlint`. `make -n check` still parses after the
  Makefile edit.

### Deviations
- Scope was set to "full cutover" by best judgment — the user was away when asked; the choice
  matches the CI note that anticipated this removal.
- `CLAUDE.md`'s `### Server` section was retargeted to the Go packages while preserving the
  ported behavioral contracts (persist/upsert semantics, maintenance, auth) rather than rewritten
  from scratch, since those invariants are held identical by the differential oracle tests.
