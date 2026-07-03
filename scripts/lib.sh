#!/usr/bin/env bash
# Shared config + launchd helpers for the Go service scripts
# (install-service.sh / deploy.sh / uninstall-service.sh).

# --- Shared config (env-overridable) ------------------------------------------
DEPLOY_ROOT="$HOME/Deploy/rss-reader"
LABEL="com.rss-reader.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-3002}"
LOCAL_API_PORT="${LOCAL_API_PORT:-4002}"
# Name the deployed binary "rss-reader" so argv[0] — the process title shown by
# ps/top/Activity Monitor — is meaningful. Go has no stdlib runtime setproctitle;
# the binary name IS the process title, so no library is needed.
BIN="$DEPLOY_ROOT/rss-reader"

# reload_service LABEL PLIST — bootout + bootstrap + kickstart, hardened against
# the `Bootstrap failed: 5: Input/output error` race: launchctl bootout is
# asynchronous, so bootstrapping immediately after can hit the still-present job.
# We wait for the job to actually disappear, then retry bootstrap a few times.
reload_service() {
  local label="$1" plist="$2" uid domain i
  uid="$(id -u)"
  domain="gui/$uid"

  launchctl bootout "$domain/$label" 2>/dev/null || true
  # bootout is async — wait until the job is really gone (up to ~10s).
  for i in $(seq 1 20); do
    launchctl print "$domain/$label" >/dev/null 2>&1 || break
    sleep 0.5
  done

  # bootstrap can transiently return EIO(5) right after teardown — retry.
  for i in $(seq 1 6); do
    if launchctl bootstrap "$domain" "$plist" 2>/dev/null; then
      launchctl kickstart -k "$domain/$label" 2>/dev/null || true
      return 0
    fi
    sleep 1
  done

  echo "!! launchctl bootstrap failed after retries for $label" >&2
  return 1
}

# kickstart_service LABEL — restart the already-bootstrapped job in place, so a
# freshly synced binary/client takes effect without rewriting the plist.
kickstart_service() {
  local label="$1"
  launchctl kickstart -k "gui/$(id -u)/$label"
}

# health_check URL — poll URL until it returns 2xx (up to ~12s). 0 = healthy.
health_check() {
  local url="$1" i
  sleep 2
  for i in $(seq 1 20); do
    if curl -sf "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}
