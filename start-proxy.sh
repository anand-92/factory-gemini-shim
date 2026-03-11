#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

restart_delay_seconds="${RESTART_DELAY_SECONDS:-2}"

while true; do
  printf '[%s] starting factory-gemini-shim\n' "$(date -Is)"
  set +e
  node server.js
  exit_code=$?
  set -e

  if [[ "$exit_code" -eq 0 ]]; then
    printf '[%s] factory-gemini-shim stopped normally\n' "$(date -Is)"
    exit 0
  fi

  printf '[%s] factory-gemini-shim exited with code %s, restarting in %ss\n' "$(date -Is)" "$exit_code" "$restart_delay_seconds"
  sleep "$restart_delay_seconds"
done
