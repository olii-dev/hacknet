# Hacknet

A community-driven file sharing platform. Upload, browse, discover, search, preview, and download files publicly.

**Stack:** Static HTML/CSS/JS on GitHub Pages · Supabase (auth + database + Edge Functions) · Mega.nz (file storage)

## Features

- **Discover** — Recent, popular, and trending file feeds
- **Search** — Live search with tags, file type filters, and sort options
- **Upload** — Drag-and-drop uploads (stored on Mega.nz)
- **Preview** — Images, PDFs, audio, and video in-browser
- **Social** — Likes, comments, user profiles
- **Collections** — Curated public lists of files
- **Moderation** — Pending upload queue and report system

## Project Structure

```
docs/           → GitHub Pages site (frontend)
supabase/
  migrations/   → Database schema, RLS, search
  functions/    → mega-preview Edge Functions (previews/downloads)
upload-worker/  → Fly.io upload service (streams files to Mega)
```

## Setup

### 1. Supabase Project

1. Create a free project at [supabase.com](https://supabase.com)
2. In the SQL Editor, run the migrations in order:
   - `supabase/migrations/001_schema.sql`
   - `supabase/migrations/002_rls.sql`
   - `supabase/migrations/003_search.sql`
   - `supabase/migrations/004_improved_search.sql`
3. Under **Authentication → Providers**, enable Email
4. Copy your **Project URL** and **anon public key** from Settings → API

### 2. Mega.nz Account

1. Create a dedicated Mega.nz account for Hacknet
2. Note the email and password — these go in Edge Function secrets only

### 3. Deploy Edge Functions

Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF

supabase secrets set MEGA_EMAIL=your@mega.email MEGA_PASSWORD=yourpassword

# Optional: second Mega account for ~40 GB total (add MEGA_EMAIL_3 / MEGA_PASSWORD_3, etc.)
supabase secrets set MEGA_EMAIL_2=second@mega.email MEGA_PASSWORD_2=secondpassword
supabase secrets set AUTO_APPROVE=false

supabase functions deploy mega-preview
supabase functions deploy mega-stats
supabase functions deploy mega-cover
```

Previews and downloads use Edge Functions. **File uploads use the upload worker** (see below) — not Supabase Edge.

`AUTO_APPROVE=true` skips the moderation queue and publishes uploads immediately.

### 3b. Deploy Upload Worker (required for uploads)

Large uploads cannot run on Supabase Edge (150s timeout). Deploy the Node worker to Fly.io:

```bash
cd upload-worker
fly auth login
fly launch --no-deploy   # use existing fly.toml, pick a unique app name if needed
fly secrets set SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
  MEGA_EMAIL=... MEGA_PASSWORD=... AUTO_APPROVE=false \
  ALLOWED_ORIGINS=https://YOUR_USERNAME.github.io
fly deploy
```

See `upload-worker/README.md` for details.

### 4. Configure Frontend

Edit `docs/js/config.js`:

```js
window.HACKNET_CONFIG = {
  supabaseUrl: 'https://YOUR_PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR_ANON_KEY',
  uploadWorkerUrl: 'https://YOUR-UPLOAD-APP.fly.dev',
  maxUploadBytes: 1024 * 1024 * 1024,
  autoApprove: false,
};
```

### 5. GitHub Pages

1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Set source to **GitHub Actions** (workflow included) or deploy from `/docs` on `main`
4. Your site will be live at `https://YOUR_USERNAME.github.io/hacknet/`

### 6. Promote a Moderator

After signing up, run in the Supabase SQL Editor:

```sql
update public.profiles
set role = 'admin'
where username = 'your_username';
```

## Limits

| Limit | Value |
|-------|-------|
| Max upload size | 1 GB via upload worker on Fly.io |
| Mega free storage | ~20 GB per account |
| Allowed file types | Images, PDF, text, JSON, ZIP, audio, video, Office docs |

## Local Development

Serve the `docs/` folder with any static server:

```bash
npx serve docs
```

Open `http://localhost:3000`. The site calls your live Supabase project — there is no local backend.

## Architecture

```
Browser (GitHub Pages)
  ├── Supabase Auth     → signup, login, sessions
  ├── Supabase Postgres → metadata, comments, likes, collections
  ├── Upload worker     → streams uploads to Mega (Fly.io)
  └── Edge Functions    → Mega preview/download proxy
        └── Mega.nz     → actual file bytes
```

Mega credentials never touch the browser. The upload worker holds Mega login and streams files with no Edge timeout.

## License

MIT
