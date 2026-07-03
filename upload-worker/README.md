# Hacknet Upload Worker

Streams uploads from the browser to Mega.nz with **no Supabase Edge timeout** and **no 50 MB Storage staging limit**.

Deploy this to [Fly.io](https://fly.io) (free tier works for light use; ~$5/mo recommended for reliability).

## Ubuntu server (always on, SSH only)

Best if you have a home server / VPS that's always running.

### From your Mac (one time)

```bash
cd /Users/olimebberson/Downloads/friendnet

# Your SSH login — change this to match your Ubuntu box
export UBUNTU_HOST=youruser@YOUR_UBUNTU_IP

./scripts/push-upload-worker.sh
```

### On Ubuntu (SSH in, one time)

```bash
ssh youruser@YOUR_UBUNTU_IP
chmod +x /tmp/install-on-ubuntu.sh
sudo USE_TUNNEL=1 /tmp/install-on-ubuntu.sh
```

The installer will:
- Install Node 20 if needed
- Run the upload worker as a **systemd service** (starts on boot)
- Start a **Cloudflare tunnel** for free HTTPS (GitHub Pages needs `https://`)

It prints a URL like `https://xxxx.trycloudflare.com` — put that in `docs/js/config.js`:

```js
uploadWorkerUrl: 'https://xxxx.trycloudflare.com',
```

**Check it's running later:**

```bash
sudo systemctl status hacknet-upload
curl http://127.0.0.1:8080/health
cat /opt/hacknet-upload/public-url.txt
```

**If the tunnel URL changes** (after reboot), run `journalctl -u hacknet-upload-tunnel -n 30` and update `config.js`.

If you own a domain pointing at that server, you can use nginx + Let's Encrypt instead of the tunnel — ask and we can wire that up.

## Quick deploy (Mac only — not always on)

```bash
# 1. Add your Mega credentials (same as Supabase secrets)
cp upload-worker/.env.example upload-worker/.env
# Edit upload-worker/.env — fill in MEGA_EMAIL and MEGA_PASSWORD

# 2. Run the deploy script (logs into Fly in your browser, deploys, updates config.js)
./scripts/deploy-upload-worker.sh

# 3. In Supabase SQL Editor, run:
#    supabase/migrations/012_upload_worker_rpc.sql
```

## Manual deploy to Fly.io

```bash
cd upload-worker
npm install

# One-time Fly setup
fly auth login
fly apps create hacknet-upload   # or pick a unique name, then update fly.toml

# Secrets (same Mega login as Supabase Edge Functions — no service role key needed)
fly secrets set \
  SUPABASE_URL=https://YOUR_PROJECT.supabase.co \
  SUPABASE_ANON_KEY=your-anon-key \
  MEGA_EMAIL=your@mega.nz \
  MEGA_PASSWORD=your-mega-password \
  AUTO_APPROVE=false \
  ALLOWED_ORIGINS=*

fly deploy
```

After deploy, copy the app URL (e.g. `https://hacknet-upload.fly.dev`) into `docs/js/config.js`:

```js
uploadWorkerUrl: 'https://hacknet-upload.fly.dev',
```

## Local dev

```bash
cp .env.example .env   # fill in values
npm run dev
```

Set `uploadWorkerUrl: 'http://localhost:8080'` in config.js while testing locally.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/upload` | Multipart upload (`file`, `title`, `description`, `tags`, `size_bytes`, `mime_type`, optional `thumbnail`) |

Requires `Authorization: Bearer <supabase_jwt>`.

## How it works

```
Browser ──multipart stream──► Fly.io worker ──stream──► Mega.nz
                                    │
                                    └──► Supabase (insert files row)
```

The worker validates your Supabase JWT, streams the file through megajs to Mega, then writes metadata to Postgres. A 180 MB upload can take several minutes — that's fine; Fly doesn't kill the connection at 150 seconds like Edge Functions.
