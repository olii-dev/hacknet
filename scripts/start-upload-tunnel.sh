#!/usr/bin/env bash
# Runs the upload worker on THIS machine and exposes it via Cloudflare Tunnel.
#
# When to use this script:
#   - Quick LOCAL test on your Mac. If /plex-usb isn't mounted here, it falls
#     back to ./upload-worker/storage so the worker still starts.
#
# When NOT to use this:
#   - In production. Your real worker lives on Ubuntu as systemd services
#     (hacknet-upload + hacknet-upload-tunnel). See scripts/install-on-ubuntu.sh.
#     If uploads 530, restart those services on Ubuntu — don't run this on the Mac.
#
# Keep this terminal open while uploading. Press Ctrl+C when done.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER="$ROOT/upload-worker"
CONFIG="$ROOT/docs/js/config.js"
PORT="${PORT:-8080}"

# Initialise PIDs up front so the cleanup trap never trips `set -u`.
WORKER_PID=""
TUNNEL_PID=""

cleanup() {
  [[ -n "${WORKER_PID:-}" ]] && kill "$WORKER_PID" 2>/dev/null || true
  [[ -n "${TUNNEL_PID:-}" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [[ ! -f "$WORKER/.env" ]]; then
  echo "Missing upload-worker/.env — copy .env.example first."
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

# .env ships STORAGE_ROOT=/plex-usb/hacknet (the Ubuntu mount). On a machine
# without that mount (e.g. your Mac), fall back to a local dir so the worker
# can still start for testing. Ubuntu is unaffected.
STORAGE_ROOT="${STORAGE_ROOT:-/plex-usb/hacknet}"
if [[ ! -d "$(dirname "$STORAGE_ROOT")" ]]; then
  STORAGE_ROOT="$WORKER/storage"
  echo "Note: /plex-usb not found on this machine — using local storage at $STORAGE_ROOT"
fi
mkdir -p "$STORAGE_ROOT/files" "$STORAGE_ROOT/thumbs"
export STORAGE_ROOT

echo "Starting upload worker on port $PORT (storage: $STORAGE_ROOT)..."
node src/server.mjs &
WORKER_PID=$!

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

# Update BOTH URL fields — the client prefers filesApiUrl, so updating only
# uploadWorkerUrl (the old behaviour) left uploads pointing at the stale URL.
if [[ -f "$CONFIG" ]] && grep -q "filesApiUrl:" "$CONFIG"; then
  perl -i -pe "s|filesApiUrl: '[^']*'|filesApiUrl: '$PUBLIC_URL'|" "$CONFIG"
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
echo "  Local:       http://127.0.0.1:$PORT/health"
echo ""
echo "  config.js updated with that URL."
echo ""
echo "  >>> Keep this terminal OPEN while uploading <<<"
echo "  Press Ctrl+C when you're done."
echo "=============================================="
echo ""

wait "$TUNNEL_PID"
