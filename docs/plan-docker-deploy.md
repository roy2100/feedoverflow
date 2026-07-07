# Plan: Docker deployment for open-source users

## Goal
Give open-source users a one-command (`docker compose up`) way to run the RSS reader,
so they don't have to install Go 1.26 + a cgo toolchain + Node just to try it. This
targets *third-party users cloning the repo*, not the maintainer's own Mac deployment
(which stays on launchd + `scripts/deploy.sh`; rathole/VPS tunnels are personal infra and
out of scope here).

## Scope
Included:
- Multi-stage `Dockerfile` (client build → cgo Go build → slim runtime).
- `docker-compose.yml`: the app service, plus RSSHub as an **optional** service behind a
  compose profile (`--profile rsshub`), wired to the app's `rsshub_base_url`.
- `.dockerignore` to keep the build context small and reproducible.
- `.env.example` documenting the container-facing env vars.
- README (en + zh-CN) "Run with Docker" section.

Explicitly out of scope:
- rathole tunnel / VPS / Caddy TLS (maintainer-only; users terminate TLS however they like).
- The Mac launchd path — unchanged.
- Publishing an image to a registry / CI build (can follow later).

## Key facts (verified in-repo)
- Backend is cgo (`mattn/go-sqlite3`) → build image needs gcc; runtime needs glibc +
  ca-certificates. Multi-stage: `golang:1.26-bookworm` (has gcc) → `debian:bookworm-slim`.
- Config is fully env-driven (`internal/config`): `PORT` (default 3002, binds all
  interfaces), `LOCAL_API_PORT` (4002, loopback), `RSS_DB` (`rss.db`), `AUTH_USER/PASS`
  (empty ⇒ auth off), `CLIENT_DIST` (`client/dist`), `LOG_DIR`, `DB_MAX_SIZE_MB`,
  `REFRESH_CONCURRENCY`, `RSS_DISABLE_JOBS`.
- No hardcoded macOS paths in the app; Linux resource monitor already exists
  (`internal/jobs/rss_linux.go` via build tags).
- `/healthz` on the loopback `:LOCAL_API_PORT` is unauthenticated → use it for the
  container HEALTHCHECK.
- `rsshub_base_url` default is `http://localhost:1200`, seeded in DB and overridable via
  settings; in compose it becomes `http://rsshub:1200`.

## Steps
1. `Dockerfile` — 3 stages:
   - `node:22-bookworm-slim`: `npm ci --legacy-peer-deps` in `client/`, `npm run build` → `client/dist`.
   - `golang:1.26-bookworm`: `CGO_ENABLED=1 go build -o /out/rss-reader .` from `server-go/`.
   - `debian:bookworm-slim`: copy binary + `client/dist`, install `ca-certificates`, create
     `/data`, set `RSS_DB=/data/rss.db`, `LOG_DIR=/data/logs`, `CLIENT_DIST=/app/client/dist`,
     non-root user, `EXPOSE 3002`, `HEALTHCHECK` on loopback `:4002/healthz`, run binary.
2. `.dockerignore` — exclude `node_modules`, `dist`, `*.db*`, `logs/`, `.git`, `server/`,
   scratch, IDE files.
3. `docker-compose.yml`:
   - `app`: build `.`, `ports: 3002:3002`, volume `rss-data:/data`, env from `.env`,
     `restart: unless-stopped`.
   - `rsshub` (profile `rsshub`): official `diygod/rsshub` image, app sets
     `rsshub_base_url=http://rsshub:1200`; `depends_on` optional.
   - named volume `rss-data`.
4. `.env.example` — `PORT`, `AUTH_USER`, `AUTH_PASS`, `DB_MAX_SIZE_MB`, etc. with comments;
   default auth left blank (local use) with a note to set it if exposing publicly.
5. Docs — add "Run with Docker" to `README.md` and `README.zh-CN.md`.
6. Verify: `docker build` succeeds; `docker compose up` serves the SPA on :3002 and
   `/healthz` returns ok. (If Docker isn't available in this environment, at minimum
   validate the Dockerfile/compose syntactically and document the manual verify steps.)

## Risks & Open Questions
- cgo build on Linux is the one moving part; if `debian-slim` misses a shared lib the
  binary needs, fall back to keeping the build image as runtime or static-musl on alpine.
- RSSHub image is heavy; keeping it behind a profile avoids forcing it on users who only
  use plain RSS feeds.
- `LOCAL_API_PORT`/MCP stays loopback inside the container (not published) — MCP over the
  loopback API is a maintainer feature; documenting it as "exec into the container" is enough.

## Estimated Complexity
Low–Medium — few files, no app-code changes; the only real risk is the cgo runtime image.

## Outcome
Delivered as planned, no app-code changes:
- `Dockerfile` — 3-stage (node:22 client build → golang:1.26 cgo build → debian:bookworm-slim
  runtime, non-root `rss` user, `/data` volume, loopback `/healthz` HEALTHCHECK).
- `docker-compose.yml` — `app` (published `3002`, `rss-data` volume) + optional `rsshub`
  behind the `rsshub` profile.
- `.dockerignore`, `.env.example`, and "Run with Docker" sections in `README.md` /
  `README.zh-CN.md`.

Deviation from plan:
- `env_file` was made **optional** (`required: false`) so `docker compose up` works before
  the user copies `.env` — `docker compose config` had errored on the missing file otherwise.

Verification (Docker daemon was **not** running in this environment, so no live image build):
- `docker compose config` passes with and without `.env`; both `app` and `rsshub` services
  resolve under the profile.
- `npm ci --legacy-peer-deps --dry-run` in `client/` → lockfile in sync (npm ci will succeed).
- `CGO_ENABLED=1 go build -trimpath -ldflags="-s -w"` compiles the backend clean (native).
- Still TODO on a machine with Docker: `docker build .` + `docker compose up` and confirm the
  SPA serves on :3002 and `/healthz` returns ok.
