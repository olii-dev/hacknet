#!/usr/bin/env bash
# Run the upload worker on your Mac (uses upload-worker/.env)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER="$ROOT/upload-worker"

if [[ ! -f "$WORKER/.env" ]]; then
  echo "Missing $WORKER/.env"
  echo "Run: cp upload-worker/.env.example upload-worker/.env"
  echo "Then fill in MEGA_EMAIL and MEGA_PASSWORD."
  exit 1
fi

cd "$WORKER"
if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Starting upload worker on http://localhost:8080"
echo "Press Ctrl+C to stop."
echo ""

set -a
# shellcheck disable=SC1091
source .env
set +a

exec node src/server.mjs
