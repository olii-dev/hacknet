# Hacknet

A community-driven file sharing platform. Upload, browse, discover, search, preview, and download files publicly.

**Stack:** Static HTML/CSS/JS on GitHub Pages · Supabase (auth + database) · Ubuntu file server (local disk) · Cloudflare Tunnel (HTTPS)

Live: https://olii-dev.github.io/hacknet/

---

## ⚠️ Known bug — uploads keep breaking (help wanted)

Uploads fail in the browser with a CORS / `530` error from `*.trycloudflare.com`. This is the #1 issue with the project right now and the main reason this repo is public — **if you want to contribute, this is the thing to fix.**

### Why it happens

The upload worker runs on an Ubuntu box (storage at `/plex-usb/hacknet`) and is exposed to the internet through a Cloudflare **quick-tunnel** (`cloudflared tunnel --url http://127.0.0.1:8787`). Quick-tunnels hand you a random `*.trycloudflare.com` subdomain **every time `cloudflared` starts**.

The frontend reads the worker URL from a hardcoded constant in [`docs/js/config.js`](docs/js/config.js):

```js
filesApiUrl: 'https://something-random.trycloudflare.com',
```

The tunnel service has `Restart=always`, so any transient blip (or every Ubuntu reboot) respawns `cloudflared` with a **brand new random URL**. `config.js` still holds the old one → the browser hits a dead hostname → Cloudflare returns `530` → Firefox reports it as "CORS Missing Allow Origin." The CORS layer is completely fine — the URL is just stale. Each manual fix is: SSH in, grep the new URL from the journal, edit `config.js`, commit, push, wait for Pages rebuild. Annoying.

### The real fix — pick one

**Option A — Named Cloudflare Tunnel + a domain** *(best, permanent, ~$2/yr)*
Register a cheap domain (e.g. `.xyz`) in a free Cloudflare account, create a named tunnel, bind it to `upload.yourdomain.xyz`, point `cloudflared` at the tunnel UUID. The URL never changes again and `config.js` becomes permanent. Setup is ~10 minutes one-time. This is the proper fix.

**Option B — Self-healing URL via Supabase** *(best free option)*
Move `filesApiUrl` out of `config.js` and into a Supabase table (e.g. `app_config(key, value)`). On `cloudflared` startup, a systemd `ExecStartPost` hook on Ubuntu greps the new tunnel URL from the journal and updates the row via the Supabase service role key. The frontend fetches the URL from Supabase at page load instead of reading a hardcoded constant. Free, self-healing, ~5s downtime per rotation. Requires changing `docs/js/supabase.js` (or wherever config loads) + writing the sync hook.

**Option C — Auto-push script** *(free, hackier)*
Same idea as B, but instead of Supabase, the Ubuntu side commits and pushes `config.js` to GitHub via `gh` whenever the URL rotates. Needs a deploy key or PAT on Ubuntu. GitHub Pages rebuild adds ~60s of downtime per rotation. Worse than B but simpler.

### Want to take it on?

1. Fork the repo
2. Pick a fix (A, B, C, or pitch your own)
3. Open a PR against `main`
4. DM [@olii-dev](https://github.com/olii-dev) if you need Supabase project access, a Cloudflare account, SSH to the Ubuntu box, or anything else to test

### Local dev (frontend only)

```bash
git clone https://github.com/olii-dev/hacknet
cd hacknet
npx serve docs
```

Open `http://localhost:3000`. The frontend talks to the live Supabase project so browsing works out of the box. Testing real uploads needs the worker + tunnel running on Ubuntu — see [`upload-worker/`](upload-worker/) and [`scripts/install-on-ubuntu.sh`](scripts/install-on-ubuntu.sh).

### Useful files

- `docs/js/config.js` — hardcoded worker URL (the thing that keeps going stale)
- `docs/js/api.js` — frontend upload/download code (`uploadViaWorker`, `getFilesApiUrl`)
- `upload-worker/src/server.mjs` — the Node upload server (`/upload`, `/files/:id`)
- `upload-worker/src/lib.mjs` — CORS headers, storage, Supabase client
- `upload-worker/deploy/hacknet-upload-tunnel.service` — the systemd unit running `cloudflared`
- `scripts/install-on-ubuntu.sh` — provisions the Ubuntu box (worker + tunnel services)
