# Ubuntu setup (you are SSH'd in here)

## What this does

- **GitHub Pages** = Hacknet website (HTML/JS) — stays as-is
- **Your Ubuntu + `/plex-usb`** = stores uploaded files (653 GB free)
- **Cloudflare tunnel** = free `https://` URL so the browser can upload (no domain needed)

No Mega. No Fly.io. No credit card.

---

## Step A — On your Mac (new Terminal window)

```bash
cd /Users/olimebberson/Downloads/friendnet
export UBUNTU_HOST=oli@YOUR_UBUNTU_IP
./scripts/push-upload-worker.sh
```

Replace `YOUR_UBUNTU_IP` with the IP you use to SSH (e.g. `oli@192.168.1.50`).

---

## Step B — On Ubuntu (your SSH session)

```bash
sudo mkdir -p /plex-usb/hacknet
sudo chown oli:oli /plex-usb/hacknet
chmod +x /tmp/install-on-ubuntu.sh
sudo USE_TUNNEL=1 /tmp/install-on-ubuntu.sh
```

Copy the `https://....trycloudflare.com` URL it prints.

---

## Step C — On your Mac (Cursor)

Open `docs/js/config.js` and set:

```js
filesApiUrl: 'https://xxxx.trycloudflare.com',
```

Also run this SQL once in **Supabase Dashboard → SQL Editor** (if not already done):

```sql
-- contents of supabase/migrations/013_local_storage.sql
```

Hard-refresh upload page. Done.

---

## Useful commands (Ubuntu)

```bash
sudo systemctl status hacknet-upload
curl http://127.0.0.1:8080/health
cat /opt/hacknet-upload/public-url.txt
df -h /plex-usb
ls /plex-usb/hacknet/files
```
