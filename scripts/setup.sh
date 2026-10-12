#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  umask 077
  key=$(openssl rand -hex 32)
  internal=$(openssl rand -hex 32)
  cat > .env <<ENV
ENCRYPTION_KEY=$key
INTERNAL_KEY=$internal
APP_ORIGIN=http://localhost:5173
HELIX_URL=http://127.0.0.1:6996
EXECUTOR_URL=http://127.0.0.1:3002
MODEL_ENDPOINT=http://framearch-juan:8000/v1
DATA_DIR=.data
ENV
  echo 'Generated local secrets in .env'
fi
if [ "${1:-}" = "--compose" ]; then
  # Tailnet access is opt-in: add the overlay only when both the password and
  # the Tailscale IP are configured. The app refuses a non-loopback origin
  # without AUTH_PASSWORD regardless.
  # Compose reads .env automatically, but the shell does not. Check both
  # exported overrides and non-empty dotenv entries without evaluating values.
  has_config() {
    [ -n "${!1:-}" ] || grep -Eq "^$1=.+" .env 2>/dev/null
  }
  if has_config AUTH_PASSWORD && has_config TAILSCALE_IP; then
    docker compose -f compose.yaml -f compose.tailnet.yaml up -d --build
  else
    docker compose up -d --build
  fi
fi
