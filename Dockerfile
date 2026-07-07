# Multi-stage build for the RSS reader.
#
# The backend is a cgo binary (mattn/go-sqlite3), so it must be built with a gcc
# toolchain and run against glibc — hence golang-bookworm build + debian-slim
# runtime rather than scratch/alpine.

# --- Stage 1: build the client (Vite/React) -----------------------------------
FROM node:22-bookworm-slim AS client
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY client/ ./
# VITE_DEMO_MODE=1 bakes in the public-demo banner (DemoBanner.tsx). Empty by
# default → production/open-source image is unaffected.
ARG VITE_DEMO_MODE=""
RUN VITE_DEMO_MODE="$VITE_DEMO_MODE" npm run build

# --- Stage 2: build the Go backend (CGO_ENABLED=1) ----------------------------
FROM golang:1.26-bookworm AS server
WORKDIR /src
COPY server-go/go.mod server-go/go.sum ./
RUN go mod download
COPY server-go/ ./
RUN CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o /out/rss-reader .

# --- Stage 3: runtime ---------------------------------------------------------
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin rss

WORKDIR /app
COPY --from=server /out/rss-reader /app/rss-reader
COPY --from=client /client/dist /app/client/dist

# Persist the SQLite DB and logs on a volume.
RUN mkdir -p /data/logs && chown -R rss:rss /data /app
VOLUME ["/data"]

ENV PORT=3002 \
    LOCAL_API_PORT=4002 \
    RSS_DB=/data/rss.db \
    LOG_DIR=/data/logs \
    CLIENT_DIST=/app/client/dist

USER rss
EXPOSE 3002

# /healthz on the loopback no-auth listener — never gated by AUTH_*.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${LOCAL_API_PORT}/healthz" || exit 1

ENTRYPOINT ["/app/rss-reader"]
