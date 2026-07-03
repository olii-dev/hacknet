#!/usr/bin/env bash
# Run ON UBUNTU (sudo). Stores files on /plex-usb/hacknet — no Mega needed.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/home/${SUDO_USER:-$USER}/hacknet-upload}"
STORAGE_ROOT="${STORAGE_ROOT:-/plex-usb/hacknet}"
USE_TUNNEL="${USE_TUNNEL:-1}"
PORT="${PORT:-8787}"
RUN_USER="${SUDO_USER:-$USER}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo ./install-on-ubuntu.sh"
  exit 1
fi

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  echo "Missing $INSTALL_DIR/.env — run push-upload-worker.sh from your Mac first."
  exit 1
fi

# Use PORT from .env if set
if grep -q '^PORT=' "$INSTALL_DIR/.env"; then
  PORT="$(grep '^PORT=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2- | tr -d '[:space:]')"
fi

echo "==> Storage on $STORAGE_ROOT"
mkdir -p "$STORAGE_ROOT/files" "$STORAGE_ROOT/thumbs"
chown -R "$RUN_USER:$RUN_USER" "$STORAGE_ROOT"

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  echo "Installing Node.js 20..."
  apt-get update -qq
  apt-get install -y curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "Installing npm packages..."
cd "$INSTALL_DIR"
sudo -u "$RUN_USER" npm install --omit=dev

# Ensure .env has STORAGE_ROOT and PORT
if ! grep -q '^STORAGE_ROOT=' "$INSTALL_DIR/.env"; then
  echo "STORAGE_ROOT=$STORAGE_ROOT" >> "$INSTALL_DIR/.env"
fi
if ! grep -q '^PORT=' "$INSTALL_DIR/.env"; then
  echo "PORT=$PORT" >> "$INSTALL_DIR/.env"
fi

echo "Installing systemd service..."
sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" -e "s|__RUN_USER__|$RUN_USER|g" \
  "$INSTALL_DIR/deploy/hacknet-upload.service" \
  > /etc/systemd/system/hacknet-upload.service
systemctl daemon-reload
systemctl enable hacknet-upload
systemctl restart hacknet-upload

sleep 2
if ! curl -sf "http://127.0.0.1:$PORT/health" >/dev/null; then
  echo ""
  echo "Server failed to start. Recent logs:"
  journalctl -u hacknet-upload -n 30 --no-pager || true
  echo ""
  echo "Try manually (as $RUN_USER):"
  echo "  cd $INSTALL_DIR && node src/server.mjs"
  echo ""
  echo "If port $PORT is busy: sudo ss -tlnp | grep :$PORT"
  exit 1
fi
echo "File server OK at http://127.0.0.1:$PORT/health"

PUBLIC_URL=""

if [[ "$USE_TUNNEL" == "1" ]]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "Installing cloudflared..."
    ARCH="$(dpkg --print-architecture)"
    case "$ARCH" in
      amd64) CF_ARCH="amd64" ;;
      arm64) CF_ARCH="arm64" ;;
      *) echo "Unsupported arch: $ARCH"; exit 1 ;;
    esac
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" \
      -o /usr/local/bin/cloudflared
    chmod +x /usr/local/bin/cloudflared
    ln -sf /usr/local/bin/cloudflared /usr/bin/cloudflared
  fi

  sed -e "s|__PORT__|$PORT|g" \
    "$INSTALL_DIR/deploy/hacknet-upload-tunnel.service" \
    > /etc/systemd/system/hacknet-upload-tunnel.service
  systemctl daemon-reload
  systemctl enable hacknet-upload-tunnel
  systemctl restart hacknet-upload-tunnel

  echo "Waiting for HTTPS tunnel URL..."
  for _ in $(seq 1 45); do
    PUBLIC_URL="$(journalctl -u hacknet-upload-tunnel -n 50 --no-pager 2>/dev/null \
      | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
    [[ -n "$PUBLIC_URL" ]] && break
    sleep 2
  done

  if [[ -n "$PUBLIC_URL" ]]; then
    echo "$PUBLIC_URL" > "$INSTALL_DIR/public-url.txt"
    if grep -q '^PUBLIC_BASE_URL=' "$INSTALL_DIR/.env"; then
      sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=$PUBLIC_URL|" "$INSTALL_DIR/.env"
    else
      echo "PUBLIC_BASE_URL=$PUBLIC_URL" >> "$INSTALL_DIR/.env"
    fi
    systemctl restart hacknet-upload
  fi
fi

echo ""
echo "=============================================="
if [[ -n "$PUBLIC_URL" ]]; then
  echo "  Put this in docs/js/config.js on your Mac:"
  echo ""
  echo "  filesApiUrl: '$PUBLIC_URL',"
  echo ""
  echo "  (Saved to $INSTALL_DIR/public-url.txt)"
else
  echo "  Tunnel URL not found yet. Run:"
  echo "  journalctl -u hacknet-upload-tunnel -n 30"
fi
echo "=============================================="
echo ""
echo "Files save to: $STORAGE_ROOT"
echo "Status: sudo systemctl status hacknet-upload"
