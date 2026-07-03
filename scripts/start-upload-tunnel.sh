#!/usr/bin/env bash
# FREE option — no Fly.io credit card.
# Runs the upload worker on your Mac and exposes it via Cloudflare Tunnel.
# Keep this terminal open while you (or others) upload files.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER="$ROOT/upload-worker"
CONFIG="$ROOT/docs/js/config.js"
PORT="${PORT:-8080}"

if [[ ! -f "$WORKER/.env" ]]; then
  echo "Missing upload-worker/.env — copy .env.example and add Mega credentials first."
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed."
  echo ""
  echo "Install it with Homebrew:"
  echo "  brew install cloudflared"
  echo ""
  echo "Or download: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

cd "$WORKER"
if [[ ! -d node_modules ]]; then
  echo "Installing npm packages..."
  npm install
fi

set -a
# shellcheck disable=SC1091
source .env
set +a
export PORT

echo "Starting upload worker on port $PORT..."
node src/server.mjs &
WORKER_PID=$!

cleanup() {
  kill "$WORKER_PID" 2>/dev/null || true
  kill "$TUNNEL_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 1
if ! kill -0 "$WORKER_PID" 2>/dev/null; then
  echo "Upload worker failed to start. Check upload-worker/.env"
  exit 1
fi

echo "Starting Cloudflare tunnel (free, no credit card)..."
echo ""

TUNNEL_LOG="$(mktemp)"
cloudflared tunnel --url "http://127.0.0.1:$PORT" 2>&1 | tee "$TUNNEL_LOG" &
TUNNEL_PID=$!

PUBLIC_URL=""
for _ in $(seq 1 60); do
  PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
  if [[ -n "$PUBLIC_URL" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$PUBLIC_URL" ]]; then
  echo "Could not get tunnel URL. Check the log above."
  exit 1
fi

if [[ -f "$CONFIG" ]] && grep -q "uploadWorkerUrl:" "$CONFIG"; then
  perl -i -pe "s|uploadWorkerUrl: '[^']*'|uploadWorkerUrl: '$PUBLIC_URL'|" "$CONFIG"
fi

echo "=============================================="
echo "  Upload server is LIVE"
echo "=============================================="
echo ""
echo "  Public URL:  $PUBLIC_URL"
echo "  Health:      $PUBLIC_URL/health"
echo ""
echo "  config.js updated with that URL."
echo ""
echo "  >>> Keep this terminal OPEN while uploading <<<"
echo "  Press Ctrl+C when you're done."
echo "=============================================="
echo ""

wait "$TUNNEL_PID"
