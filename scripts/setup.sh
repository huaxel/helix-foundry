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
if [ "${1:-}" = "--compose" ]; then docker compose up -d --build; fi
