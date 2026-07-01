# Plan: Migrate the backend core to Go (excluding MCP)

## Goal
Rewrite the Node/Express + better-sqlite3 backend in Go, keeping the exact HTTP/JSON API contract
and the existing `rss.db` schema/data, so the unchanged React client and the rathole/Caddy tunnel
keep working. Motivation is **not** the perf bugs (concurrent stall + WAL growth are already fixed
in the Node app); it's the durable wins Go offers: a **single self-contained binary** (drops the
Node ≥ 24 runtime dependency the launchd job carries — one file to deploy, built on the Mac it runs
on), **real parallelism** (a slow SQLite write or RSS parse in one goroutine can't freeze request
serving — structural immunity to the class of bug we just patched), and a **smaller resident
footprint** (~20–40 MB vs ~130 MB, which softens — but does not eliminate — the idle page-compression
wake latency). MCP is explicitly out of scope for this pass.

**SQLite driver: decided — `mattn/go-sqlite3` (cgo).** It's the mature, battle-tested binding whose
behavior is closest to `better-sqlite3` (both wrap SQLite-proper, so WAL/pragmas/quirks match) and
it's faster than the pure-Go alternative — the right call for a 439 MB DB. Trade-offs accepted:
cgo requires a C toolchain at build time and the binary links the system libc (not 100 % static),
but since we build on the same macOS host we deploy to, it's still a single self-contained binary
and there's no cross-compilation need. `CGO_ENABLED=1` in the build.

## Scope
### In
- Port the ~1,760 LOC of core server logic (everything under `server/` except `vendor/slog.ts`,
  `mcp.ts`, and tests): HTTP layer, both listeners, auth, SQLite access, RSS fetch/persist chain,
  the poller/maintenance/cache-warming/WAL-checkpoint/resource-monitor background jobs, favicon
  cache, Readability full-text, SSRF guard, and all `/api/*` routes.
- **Reuse the existing `rss.db` as-is** — same schema, same file; Go opens it directly. No data
  migration. This is the single biggest de-risker.
- Serve the existing Vite `dist/` build (static + SPA fallback) — the client is untouched.
- Keep session-cookie auth, the login rate-limit, and the two-listener model (public auth-gated on
  `PORT`; loopback no-auth on `LOCAL_API_PORT`).

### Out (explicitly)
- **MCP** (`mcp.ts`, `@modelcontextprotocol/sdk`) — not ported this pass. Consequence: the loopback
  no-auth listener loses its main consumer; **keep it (decided)** — still used by
  `scripts/burst-latency.sh` and reserved as the future MCP host.
- The React client, the DB schema, the rathole/Caddy tunnel, and the launchd topology (only the
  program the plist launches changes: `node …/index.ts` → the Go binary).
- No behavior changes — strict parity with the current API.

## Dependency & module mapping (Node → Go)
| Node piece | Go replacement | Notes / risk |
|---|---|---|
| `express`, `compression`, `cors` | `net/http` + **`chi`** + gzip/CORS middleware | Decided. chi gives clean middleware for auth/gzip/cors and per-domain sub-routers matching `routes/`. |
| `better-sqlite3` (sync, WAL) | **`mattn/go-sqlite3`** (cgo) | Decided. Wraps SQLite-proper (closest behavior parity to better-sqlite3), fastest option; `CGO_ENABLED=1`, needs a C toolchain, links system libc. |
| `rss-parser` + `xml2js` | `mmcdole/gofeed` | Medium — field-mapping parity (see parity risks). |
| `@mozilla/readability` + `jsdom` | `go-shiori/go-readability` | Medium — output won't be byte-identical; acceptable (it's on-demand, not persisted). |
| `express-rate-limit` | `golang.org/x/time/rate` or small custom limiter | Low. |
| `zod` | Go structs + explicit validation (or `go-playground/validator`) | Low — little validation surface. |
| `vendor/slog.ts` (NDJSON) | **stdlib `log/slog`** (`slog.JSONHandler`) over **`lumberjack`** | Decided. Drops 681 vendored lines; lumberjack reproduces the current size-rotation + gzip + retention. |
| `crypto` timingSafeEqual, cookies | `crypto/subtle`, `net/http` cookies | Low. |
| poller/maintenance timers | `time.Ticker` + goroutines | Low, but write-serialization matters (see risks). |
| `load-env.ts` | `godotenv` or manual `.env` parse | Low. |

## Development phases (gated)

**Working agreement (applies to every phase):**
- Phases are done **in order**; do **not** start phase N+1 until phase N's *Verify* passes.
- Each phase ends with a concrete, runnable verification. If it doesn't pass, fix within the phase.
- **Stop-and-discuss** the moment a *Stop-if* trigger fires or anything is uncertain — surface it,
  don't guess or work around it.
- Until Phase 12, **never touch the production DB**. Work against a **copy**:
  `cp ~/Deploy/rss-reader/server/rss.db* /tmp/rss-parity/` and point `server-go` at the copy.
- Keep the Node server the source of truth / oracle throughout; the Go build runs on a spare port.
- Each phase = its own commit once green.

---

### Phase 0 — Scaffold & cgo toolchain
Create `server-go/` (beside `server/`): `go.mod`, package skeleton (`main`, `db`, `articles`,
`feeds`, `httpapi`, `auth`, `jobs`), `chi` + `mattn/go-sqlite3` deps, a `/healthz` handler.
- **Verify:** `CGO_ENABLED=1 go build ./...` succeeds; binary runs; `curl :NNNN/healthz` → 200.
- **Stop-if:** cgo/C-toolchain problems on the Mac, or Go version constraints surface.

### Phase 1 — DB open + schema parity (read-only)
Open the **copy** of `rss.db` via mattn; set `journal_mode=WAL`, `synchronous=NORMAL`, a
`busy_timeout`. Port the schema guards/migrations as idempotent statements.
- **Verify:** on a *fresh empty* file, the Go schema-init produces a schema **identical** to Node's
  (`sqlite3 nodedb .schema` vs `sqlite3 godb .schema` → diff clean). On the copy, `PRAGMA
  integrity_check` = ok and table row counts match `sqlite3` CLI.
- **Stop-if:** any schema drift, or a migration whose intent is ambiguous.

### Phase 2 — Parity-critical domain core *(the real risk — gate hard here)*
Port `articles.ts` id/enrich/dedup + `rowToArticle` and `dates.ts` (`parsePubDate`, `pubTs`).
- **Verify (golden tests):**
  1. Dump a fixture from Node: for a large sample, `(link,title,pub_date) → article_id, pub_ts,
     normalized ISO date`. Go must reproduce **every** value byte-identically.
  2. Recompute `article_id` from the stored `link/title/pub_date` of **all existing rows** in the
     copy DB; assert it equals the stored `article_id` for ~100% (any miss = future duplication).
- **Stop-if:** a single ID or `pub_ts` mismatch — do not proceed; discuss the hashing/date rule.

### Phase 3 — Read endpoints (no writes, no network) + contract-diff harness
Implement the pure-read routes: `/api/feeds`, `/api/all-articles` (latest|digest), `/api/today`
(latest|digest), `/api/starred`, `/api/starred/count`, `/api/podcasts`, `/api/articles/:id/content`,
`GET /api/settings`. Build a `contract-diff` script (Node vs Go on the same copy DB → normalized
`jq` diff).
- **Verify:** contract-diff is **empty** for every read endpoint (JSON shape + values match, key
  order normalized).
- **Stop-if:** any structural difference (field names, null vs "", number vs string, ordering rule).

### Phase 4 — Auth + two-listener model
Session CRUD, cookie issue/verify, login rate-limit, timing-safe compare, `Secure` from
`X-Forwarded-Proto` (trust-proxy equivalent), the `/api/*` gate on the public listener, and the
loopback no-auth listener on `LOCAL_API_PORT`.
- **Verify (curl scenarios):** login sets cookie → authed request 200; no/invalid cookie → 401;
  loopback port serves the same request **without** a cookie; >N logins → rate-limited; `Secure`
  flag present only when `X-Forwarded-Proto: https`.
- **Stop-if:** cookie/`Secure`/proxy or the socket-decides-auth semantics don't match exactly.

### Phase 5 — Write paths + write-serialization
`POST /api/articles/star` (upsert `is_starred`, never clobber other fields), `PATCH /api/settings`,
`GET|POST /api/current-article`. Establish the single-writer discipline (one write conn / mutex +
read pool).
- **Verify:** star via Go → `is_starred` persists and survives a re-read; un-star works; a
  concurrent read+write burst leaves `PRAGMA integrity_check` = ok; behavior diffs clean vs Node.
- **Stop-if:** `SQLITE_BUSY` under concurrency, or the chosen write-serialization feels unclear.

### Phase 6 — RSS fetch chain (network) *(parity depends on Phase 2)*
`parseURL` via gofeed; `refreshFeed` single-flight + concurrency cap; `ensureFresh` TTL;
`persistItems` upsert (guarded `WHERE …<>excluded…`, `content_updated_at` on real edits,
`is_starred`/`feed_url` untouched).
- **Verify:** against the copy DB, refresh a real feed → new items insert with **Phase-2-correct
  IDs**; an immediate re-fetch is a **no-op** (no `updated_at` churn on unchanged rows); a genuine
  content edit stamps `content_updated_at`. Port the live-network suites (coindesk/sspai/reddit) as
  Go `_itest`. Compare row deltas against Node fetching the same feed.
- **Stop-if:** gofeed field mapping diverges (enclosure/audio, `content:encoded`, author, dates) or
  any re-fetch produces duplicate rows.

### Phase 7 — Feeds CRUD + OPML + orphan adoption
`POST/PATCH/DELETE /api/feeds`, `import-opml`, unique-URL collapse, delete-purges-non-starred,
`adoptStarredOrphans` on re-add.
- **Verify:** add/rename/delete; delete keeps starred + purges the rest; re-adding a URL re-adopts
  its kept starred orphans; OPML import skips dupes. All diffed vs Node.
- **Stop-if:** unique-URL collapse or orphan-adoption edge cases behave differently.

### Phase 8 — On-demand content: fetch-content (Readability) + SSRF + favicon
`/api/fetch-content` via `go-readability`; port `ssrf.ts`; `/api/favicon` (Google s2, BLOB,
positive/negative TTL, placeholder fallback).
- **Verify:** the existing SSRF test cases (private/loopback/link-local/IPv4-mapped IPv6, resolve
  then re-check) all pass as Go tests; fetch-content returns readable text for a few real URLs;
  favicon caches a BLOB, serves a placeholder on failure, honors negative TTL.
- **Stop-if:** SSRF coverage isn't a superset of the current guard, or Readability output is
  unusable for real articles (discuss acceptability — it won't be byte-identical).

### Phase 9 — Background jobs
Cache warming (bounded fan-out), poller (15 min, staggered), maintenance (orphans + size cap +
`VACUUM`), WAL `TRUNCATE` checkpoint (5 min), resource monitor (5 min).
- **Verify:** startup warming runs bounded (log shows it); poller persists on its timer;
  `enforceSizeCap` on a synthetic over-cap copy DB trims to ~90% + never deletes starred; the
  checkpoint keeps `-wal` small under load; a resource sample is logged.
- **Stop-if:** size-cap deletion selects wrong rows, or a job blocks request serving.

### Phase 10 — Static/SPA + logging
Serve `client/dist` + SPA fallback (public listener only); `log/slog` JSON over `lumberjack`.
- **Verify:** `GET /` serves `index.html`; unknown non-`/api` path → SPA fallback; `/api/*` never
  caught by the fallback; logs are NDJSON with the current field set; rotation fires at the size cap.
- **Stop-if:** SPA fallback shadows an API route, or log shape drifts from the current NDJSON.

### Phase 11 — Full contract-diff + soak (parallel run)
Run Go on a spare port against a copy of the production DB; run contract-diff across **all**
endpoints; run `scripts/burst-latency.sh BASE_URL=…` against Go; let it soak.
- **Verify:** contract-diff empty for every endpoint; burst latencies acceptable; no errors in the
  Go log over the soak; RSS memory footprint recorded (expect well under Node's ~130 MB).
- **Stop-if:** any endpoint diffs, or latency/memory is worse than expected.

### Phase 12 — Cutover (production)
Update `scripts/deploy-mac.sh` to build the Go binary (`CGO_ENABLED=1`, on the Mac) and rsync it;
add/adjust the launchd job to launch the binary; keep the Node tree in place for rollback.
- **Verify:** production serves via Go on `PORT`; `rss.lan` (Caddy) and the public tunnel both work;
  auth works end-to-end; **rollback rehearsed** (flip launchd back to Node and confirm).
- **Stop-if (mandatory discuss before flipping):** confirm the go/no-go with fresh eyes before
  touching the production launchd job.

## Risks & Open Questions
- **Article-ID parity is critical.** `article_id = md5(link || title+pubDate).slice(0,12)` and
  `pub_ts` parsing must produce **identical** values in Go, or every re-fetch re-inserts as a new
  row against the existing 439 MB DB (mass duplication, broken dedup). Port with the Node output as
  a golden test before anything else.
- **Date parsing parity.** `parsePubDate` handles non-standard RFC-822 variants some feeds emit;
  gofeed + Go's time parsing differ. Needs a fixture suite comparing against current behavior.
- **SQLite driver = `mattn/go-sqlite3` (decided).** Residual risks to watch: (a) the build now needs
  Xcode command-line tools / a C compiler and `CGO_ENABLED=1`, so `scripts/deploy-mac.sh` must build
  on the Mac (no cgo cross-compile); (b) the binary links system libc, so it's single-file but not
  100 % static — fine for a fixed macOS target; (c) confirm the driver is opened with WAL +
  `synchronous=NORMAL` + a `busy_timeout` so concurrent readers don't hit `SQLITE_BUSY`.
- **Write serialization.** SQLite is single-writer regardless of language; Go's easy concurrency
  makes it easy to create writer contention. Use one dedicated write connection (or a mutex) + a
  read pool. This is the same discipline that fixed the Node stall — not free in Go.
- **Readability output differs** — go-readability won't match `@mozilla/readability` exactly; fine
  since `/api/fetch-content` isn't persisted, but verify a few real articles.
- **What the migration does NOT fix:** WAL still needs the periodic TRUNCATE checkpoint (SQLite
  behavior), and the idle page-compression wake latency is only softened by the smaller footprint,
  not removed (OS-level).
- **Resolved decisions:** SQLite driver = `mattn/go-sqlite3`; router = `chi`; keep the loopback
  no-auth listener; repo layout = new `server-go/` beside `server/` during migration (final home
  decided post-cutover); logging = stdlib `log/slog` JSON over `lumberjack` (size rotation + gzip +
  retention, matching the current vendored logger). No open questions remain — ready to scaffold.

## Estimated Complexity
**Medium.** ~1,760 LOC of mostly straightforward CRUD + background jobs, and Go's stdlib (`log/slog`,
`net/http`, `crypto`) plus mature libs (gofeed, go-readability, a SQLite driver) cover most of it.
Rough effort for someone fluent in Go: **~4–6 focused days** — roughly 1 day DB+domain+ID/date
parity (the risky core), 1–1.5 days routes, 1 day auth+favicon+SSRF, 1 day background jobs +
static, 1 day tests + contract-diff + cutover. Add buffer if learning Go or if the SQLite
driver/gofeed edge cases bite. The dominant risk is **data-format parity** (article IDs, pub_ts,
dates) against the live 439 MB DB, not the HTTP surface. Low blast radius: parallel build, unchanged
client and schema, reversible cutover (flip one launchd line back).
