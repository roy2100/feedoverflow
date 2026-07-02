#!/usr/bin/env bash
# Shared launchd helpers for the Go deploy/rollback scripts.

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
