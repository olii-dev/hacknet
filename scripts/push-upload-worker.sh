#!/usr/bin/env bash
# Run this ON YOUR MAC — copies the upload worker to your Ubuntu server over SSH.
#
# Usage (NO sudo on Mac):
#   cd /Users/olimebberson/Downloads/friendnet
#   export UBUNTU_HOST=oli@100.102.182.56
#   ./scripts/push-upload-worker.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${UBUNTU_HOST:-}"

if [[ -z "$HOST" ]]; then
  echo "Set your SSH address first:"
  echo ""
  echo "  export UBUNTU_HOST=oli@100.102.182.56"
  echo "  ./scripts/push-upload-worker.sh"
  exit 1
fi

if [[ ! -f "$ROOT/upload-worker/.env" ]]; then
  echo "Missing upload-worker/.env"
  echo "Run: cp upload-worker/.env.example upload-worker/.env"
  exit 1
fi

# Home folder on Ubuntu — no sudo needed to copy files
REMOTE_DIR="hacknet-upload"

echo "==> Copying files to $HOST:~/$REMOTE_DIR"
ssh "$HOST" "mkdir -p $REMOTE_DIR"

rsync -avz --delete \
  --exclude node_modules \
  --exclude .bin \
  "$ROOT/upload-worker/" "$HOST:$REMOTE_DIR/"

rsync -avz "$ROOT/scripts/install-on-ubuntu.sh" "$HOST:~/install-on-ubuntu.sh"

echo ""
echo "==> Done copying."
echo ""
echo "Now SSH into Ubuntu and run:"
echo ""
echo "  ssh $HOST"
echo "  chmod +x ~/install-on-ubuntu.sh"
echo "  sudo USE_TUNNEL=1 ~/install-on-ubuntu.sh"
echo ""
echo "  (sudo is only on Ubuntu, for installing the service — it will ask YOUR ubuntu password)"
