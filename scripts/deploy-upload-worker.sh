#!/usr/bin/env bash
# Deploy Hacknet upload worker to Fly.io (one-time setup + deploy)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER="$ROOT/upload-worker"
FLY="$WORKER/.bin/flyctl"
APP_NAME="${FLY_APP_NAME:-hacknet-upload-$(whoami | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')}"

cd "$WORKER"

if [[ ! -x "$FLY" ]]; then
  echo "Downloading flyctl..."
  mkdir -p .bin
  ARCH="$(uname -m)"
  case "$ARCH" in
    arm64) FLY_ARCH="arm64" ;;
    x86_64) FLY_ARCH="x86_64" ;;
    *) echo "Unsupported arch: $ARCH"; exit 1 ;;
  esac
  curl -fsSL "https://github.com/superfly/flyctl/releases/download/v0.3.140/flyctl_0.3.140_macOS_${FLY_ARCH}.tar.gz" \
    | tar -xz -C .bin
fi

echo "==> Fly.io login (opens browser if needed)"
if ! "$FLY" auth whoami &>/dev/null; then
  "$FLY" auth login
fi

echo "==> Secrets"
if [[ -f "$WORKER/.env" ]]; then
  # shellcheck disable=SC1091
  source "$WORKER/.env"
fi

: "${SUPABASE_URL:?Set SUPABASE_URL in upload-worker/.env}"
: "${SUPABASE_ANON_KEY:?Set SUPABASE_ANON_KEY in upload-worker/.env}"
: "${MEGA_EMAIL:?Set MEGA_EMAIL in upload-worker/.env}"
: "${MEGA_PASSWORD:?Set MEGA_PASSWORD in upload-worker/.env}"

ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-*}"
AUTO_APPROVE="${AUTO_APPROVE:-false}"

if [[ ! -f fly.toml ]] || ! grep -q "app = \"$APP_NAME\"" fly.toml 2>/dev/null; then
  if "$FLY" apps list 2>/dev/null | grep -q "^$APP_NAME"; then
    echo "Using existing Fly app: $APP_NAME"
  else
    echo "Creating Fly app: $APP_NAME"
    if ! "$FLY" apps create "$APP_NAME"; then
      echo ""
      echo "Fly.io would not create the app (often needs a card on file)."
      echo ""
      echo "FREE alternative — no credit card:"
      echo "  ./scripts/start-upload-tunnel.sh"
      echo "  (keep that terminal open while uploading)"
      echo ""
      echo "Or deploy on Render.com — see render.yaml in the repo."
      exit 1
    fi
  fi
  sed -i.bak "s/^app = .*/app = \"$APP_NAME\"/" fly.toml && rm -f fly.toml.bak
fi

echo "==> Setting Fly secrets"
"$FLY" secrets set \
  SUPABASE_URL="$SUPABASE_URL" \
  SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
  MEGA_EMAIL="$MEGA_EMAIL" \
  MEGA_PASSWORD="$MEGA_PASSWORD" \
  AUTO_APPROVE="$AUTO_APPROVE" \
  ALLOWED_ORIGINS="$ALLOWED_ORIGINS" \
  --app "$APP_NAME"

if [[ -n "${MEGA_EMAIL_2:-}" && -n "${MEGA_PASSWORD_2:-}" ]]; then
  "$FLY" secrets set MEGA_EMAIL_2="$MEGA_EMAIL_2" MEGA_PASSWORD_2="$MEGA_PASSWORD_2" --app "$APP_NAME"
fi

echo "==> Deploying"
"$FLY" deploy --app "$APP_NAME"

URL="https://${APP_NAME}.fly.dev"
echo ""
echo "Deployed: $URL"
echo "Health:   $URL/health"
echo ""

CONFIG="$ROOT/docs/js/config.js"
if [[ -f "$CONFIG" ]]; then
  if grep -q "uploadWorkerUrl:" "$CONFIG"; then
    perl -i -pe "s|uploadWorkerUrl: '[^']*'|uploadWorkerUrl: '$URL'|" "$CONFIG"
    echo "Updated docs/js/config.js uploadWorkerUrl -> $URL"
  fi
fi

echo ""
echo "Next: apply migration 012_upload_worker_rpc.sql in Supabase SQL Editor (if not done)."
echo "Then hard-refresh the upload page and try a large file."
